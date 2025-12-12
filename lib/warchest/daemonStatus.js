'use strict';

const fs = require('fs');
const path = require('path');

const WARCHEST_DIR = path.join(process.cwd(), 'data', 'warchest');
const WARCHEST_PID_FILE = path.join(WARCHEST_DIR, 'warchest.pid');

function readPidFile() {
  try {
    const raw = fs.readFileSync(WARCHEST_PID_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return true;
    }
    return false;
  }
}

function isWarchestServiceRunning() {
  const info = readPidFile();
  if (!info || typeof info.pid !== 'number') {
    return false;
  }
  return isProcessAlive(info.pid);
}

module.exports = {
  readPidFile,
  isWarchestServiceRunning,
  WARCHEST_PID_FILE,
};
