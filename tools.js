'use strict';

// All tool files live at repo root level
const testAudit = require('./test-audit');

module.exports = [
    testAudit,
    // Sprint B tools added here:
    // require('./seo-audit'),
    // require('./keyword-analysis'),
    // require('./crm-contact-create'),
];
