This /packages directory contains git submodules.  Don't make changes in here unless utterly crucial as you may inadvertently cause issues in other software.

'BootyBox' is our database abstraction layer that supports either MySQL or SQLite.  Both adapters maintain functional parity and there is a unit test that checks it which MUST pass every time.