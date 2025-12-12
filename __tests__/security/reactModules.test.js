const fs = require('fs');
const path = require('path');

const DISALLOWED = [
  'react-server-dom-webpack',
  'react-server-dom-parcel',
  'react-server-dom-turbopack',
];

const packageLockPath = path.resolve(__dirname, '..', '..', 'package-lock.json');

describe('React security posture', () => {
  test('disallowed React Server DOM packages are not installed', () => {
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
    const packages = packageLock.packages || {};

    const installed = DISALLOWED.filter((name) =>
      Object.prototype.hasOwnProperty.call(packages, `node_modules/${name}`),
    );

    expect(installed).toEqual([]);
  });
});
