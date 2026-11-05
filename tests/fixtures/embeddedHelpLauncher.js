'use strict';
const fs = require('fs');
const path = require('path');
const root = process.env.VK_TEST_HELP_ROOT;
require('../../embedded').start({
  singleInstance: false,
  help: { documentPath: path.join(root, 'help.html'), cwd: path.join(root, 'guide'), prompts: { claude: '/helper', codex: '$helper' } },
  getHelpStatus: async () => JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8')),
});
