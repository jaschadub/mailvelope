/**
 * Copyright (C) 2015-2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
import {mapError, MvError} from '../lib/util';
import {prefs} from '../modules/prefs';
import {createController} from './main.controller';
import {SubController} from './sub.controller';
import * as uiLog from '../modules/uiLog';
import * as pwdCache from '../modules/pwdCache';
import * as sync from './sync.controller';
import {getById as getKeyringById} from '../modules/keyring';
import {createPrivateKeyBackup, restorePrivateKeyBackup} from '../modules/pgpModel';

export default class PrivateKeyController extends SubController {
  constructor(port) {
    super(port);
    this.state = {
      keyringId: null,
      restorePassword: false,
      host: null
    };
    this.options = null;
    this.backupCodePopup = null;
    this.keyBackup = null;
    this.pwdControl = null;
    this.initialSetup = true;
    this.newKeyFpr = '';
    this.rejectTimer = 0;
    // register event handlers
    this.on('set-init-data', this.setInitData);
    this.on('keygen-user-input', this.onUserInput);
    this.on('key-backup-user-input', this.onUserInput);
    this.on('generate-key', this.onGenerateKey);
    this.on('generate-confirm', this.onGenerateConfirm);
    this.on('generate-reject', this.onGenerateReject);
    this.on('set-keybackup-window-props', this.setKeybackupProps);
    this.on('input-check', this.onInputCheck);
    this.on('keygen-dialog-init', () => this.ports.keyGenCont.emit('dialog-done'));
    this.on('keybackup-dialog-init', this.onKeybackDialogInit);
    this.on('restore-backup-dialog-init', () => this.ports.restoreBackupCont.emit('dialog-done'));
    this.on('restore-backup-code', msg => this.restorePrivateKeyBackup(msg.code));
    this.on('backup-code-window-init', () => this.ports.keyBackupCont.emit('popup-isready'));
    this.on('get-logo-image', async () => this.ports.recoverySheet.emit('set-logo-image', {image: await this.getLogoImage()}));
    this.on('get-backup-code', () => this.ports.recoverySheet.emit('set-backup-code', {backupCode: this.getBackupCode()}));
    this.on('create-backup-code-window', this.createBackupCodeWindow);
  }

  setInitData({data}) {
    this.setState({
      keyringId: data.keyringId || this.state.keyringId,
      restorePassword: data.restorePassword || this.state.restorePassword
    });
  }

  onUserInput(msg) {
    uiLog.push(msg.source, msg.type);
  }

  onGenerateKey(msg) {
    this.setState({keyringId: msg.keyringId});
    this.options = msg.options;
    this.ports.keyGenDialog.emit('check-dialog-inputs');
  }

  onGenerateConfirm() {
    if (this.rejectTimer) {
      clearTimeout(this.rejectTimer);
      this.rejectTimer = 0;
    }
  }

  onGenerateReject() {
    if (this.rejectTimer) {
      clearTimeout(this.rejectTimer);
      this.rejectTimer = 0;
      this.rejectKey(this.newKeyFpr);
    }
  }

  setKeybackupProps(msg) {
    this.setState({keyringId: msg.keyringId, host: msg.host});
    this.initialSetup = msg.initialSetup;
  }

  onInputCheck(msg) {
    if (msg.isValid) {
      this.generateKey(msg.pwd, this.options);
    } else {
      this.ports.keyGenCont.emit('generate-done', {error: {message: 'The inputs "password" and "confirm" are not valid', code: 'INPUT_NOT_VALID'}});
    }
  }

  onKeybackDialogInit() {
    this.ports.keyBackupDialog.emit('set-init-data', {data: {initialSetup: this.initialSetup}});
    this.ports.keyBackupCont.emit('dialog-done');
  }

  createBackupCodeWindow() {
    try {
      this.createPrivateKeyBackup();
    } catch (err) {
      this.ports.keyBackupCont.emit('popup-isready', {error: mapError(err)});
    }
  }

  async generateKey(password, options) {
    if (options.keySize !== 2048 && options.keySize !== 4096) {
      this.ports.keyGenDialog.emit('show-password');
      this.ports.keyGenCont.emit('generate-done', {error: {message: 'Invalid key length', code: 'KEY_LENGTH_INVALID'}});
      return;
    }
    this.ports.keyGenDialog.emit('show-waiting');
    try {
      const keyring = await getKeyringById(this.state.keyringId);
      const {publicKey, privateKey} = await keyring.generateKey({
        keyAlgo: 'rsa',
        userIds: options.userIds,
        numBits: options.keySize,
        passphrase: password,
        unlocked: true
      });
      this.ports.keyGenCont.emit('generate-done', {publicKey: publicKey.armor()});
      if (prefs.security.password_cache) {
        await pwdCache.set({key: privateKey, password});
      }
      if (options.confirmRequired) {
        this.newKeyFpr = publicKey.getFingerprint();
        this.rejectTimer = setTimeout(() => {
          this.rejectKey(this.newKeyFpr);
          this.rejectTimer = 0;
        }, 10000); // trigger timeout after 10s
      }
    } catch (err) {
      this.ports.keyGenCont.emit('generate-done', {error: mapError(err)});
    }
  }

  async rejectKey() {
    const keyring = await getKeyringById(this.state.keyringId);
    await keyring.removeKey(this.newKeyFpr, 'private');
    if (prefs.security.password_cache) {
      pwdCache.delete(this.newKeyFpr);
    }
  }

  async createPrivateKeyBackup() {
    const keyring = await getKeyringById(this.state.keyringId);
    const defaultKey = await keyring.getDefaultKey();
    if (!defaultKey) {
      throw new MvError('No private key for backup', 'NO_PRIVATE_KEY');
    }
    this.pwdControl = await createController('pwdDialog');
    try {
      // get password from cache or ask user
      const unlockedKey = await this.pwdControl.unlockKey({
        key: defaultKey,
        reason: 'PWD_DIALOG_REASON_CREATE_BACKUP'
      });
      sync.triggerSync({keyringId: this.state.keyringId, key: unlockedKey.key, password: unlockedKey.password});
      this.keyBackup = await createPrivateKeyBackup(defaultKey, unlockedKey.password);
      await (await sync.getByKeyring(this.state.keyringId)).backup({backup: this.keyBackup.message});
      let page = 'recoverySheet.html';
      switch (this.state.host) {
        case 'web.de':
          page += `?brand=webde&id=${this.id}`;
          break;
        case 'gmx.net':
        case 'gmx.com':
        case 'gmx.co.uk':
        case 'gmx.fr':
        case 'gmx.es':
          page += `?brand=gmx&id=${this.id}`;
          break;
        default:
          page += `?id=${this.id}`;
          break;
      }
      const path = `components/recovery-sheet/${page}`;
      const popup = await mvelo.windows.openPopup(path, {width: 1024, height: 550});
      this.backupCodePopup = popup;
      popup.addRemoveListener(() => this.backupCodePopup = null);
    } catch (err) {
      this.ports.keyBackupDialog.emit('error-message', {error: mapError(err)});
    }
  }

  async restorePrivateKeyBackup(code) {
    try {
      const ctrl = await sync.getByKeyring(this.state.keyringId);
      const data = await ctrl.restore();
      const backup = await restorePrivateKeyBackup(data.backup, code);
      const keyring = await getKeyringById(this.state.keyringId);
      const result = await keyring.importKeys([{armored: backup.key.armor(), type: 'private'}]);
      // Check for errors in the result array
      for (let i = 0; i < result.length; i++) {
        if (result[i].type === 'error') {
          throw result[i].message;
        }
      }
      if (this.state.restorePassword) {
        this.ports.restoreBackupDialog.emit('set-password', {password: backup.password});
      }
      this.ports.restoreBackupCont.emit('restore-backup-done', {data: backup.key.toPublic().armor()});
      sync.triggerSync({keyringId: this.state.keyringId, key: backup.key, password: backup.password});
    } catch (err) {
      this.ports.restoreBackupDialog.emit('error-message', {error: mapError(err)});
      if (err.code !== 'WRONG_RESTORE_CODE') {
        this.ports.restoreBackupCont.emit('restore-backup-done', {error: mapError(err)});
      }
    }
  }

  async getLogoImage() {
    const keyring = await getKeyringById(this.state.keyringId);
    const attr = await keyring.getAttributes();
    return (attr && attr.logo_data_url) ? attr.logo_data_url : null;
  }

  getBackupCode() {
    return this.keyBackup.backupCode;
  }
}
