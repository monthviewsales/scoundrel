'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoundrel-test-bootybox-'));
process.env.BOOTYBOX_SQLITE_PATH = path.join(tmpDir, 'bootybox.db');
