// extract/index.js orchestrates the scanner seam (extract/csharp.js, extract/js.js, extract/link.js,
// extract/dsl.js). This shim keeps require('./extract') working for main.js and any packaged build.
module.exports = require('./extract/index.js');
