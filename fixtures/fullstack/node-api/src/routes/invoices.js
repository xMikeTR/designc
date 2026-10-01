const express = require('express');
const router = express.Router();

router.get('/invoices/:id', (req, res) => {
  res.json({ id: req.params.id });
});

router.post('/invoices', (req, res) => {
  res.status(201).json({ created: true });
});

module.exports = router;
