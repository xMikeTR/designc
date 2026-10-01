const express = require('express');
const invoicesRouter = require('./routes/invoices');

const app = express();
app.use(express.json());
app.use('/api/v2', invoicesRouter);

app.listen(5020, () => console.log('node-api listening on 5020'));

module.exports = app;
