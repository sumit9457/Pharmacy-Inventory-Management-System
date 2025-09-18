// index.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sql = require('mssql');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ------------- CONFIG: change to your SQL Server values -------------
const dbConfig = {
  user: 'YOUR_DB_USER',       // or use integratedSecurity via Trusted Connection (see mssql docs)
  password: 'YOUR_DB_PASS',
  server: 'localhost',        // or 'YOUR-SQL-SERVER'
  database: 'PharmacyDB',
  options: {
    encrypt: false,           // true if using Azure or encrypted connection
    trustServerCertificate: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};
// -------------------------------------------------------------------

async function getPool() {
  if (!global.pool) {
    global.pool = await sql.connect(dbConfig);
  }
  return global.pool;
}

/* Helper: send error */
function handleError(res, err) {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
}

/* GET /medicines - list all */
app.get('/medicines', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT * FROM dbo.Medicines ORDER BY Name');
    res.json(result.recordset);
  } catch (err) { handleError(res, err); }
});

/* GET /medicines/:id - get single */
app.get('/medicines/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM dbo.Medicines WHERE MedicineID = @id');
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.recordset[0]);
  } catch (err) { handleError(res, err); }
});

/* POST /medicines - create */
app.post('/medicines', async (req, res) => {
  try {
    const { SKU, Name, Manufacturer, UnitPrice, QuantityOnHand, ExpiryDate } = req.body;
    if (!SKU || !Name) return res.status(400).json({ error: 'SKU and Name required' });

    const pool = await getPool();
    const insert = await pool.request()
      .input('SKU', sql.NVarChar(50), SKU)
      .input('Name', sql.NVarChar(250), Name)
      .input('Manufacturer', sql.NVarChar(200), Manufacturer)
      .input('UnitPrice', sql.Decimal(10,2), UnitPrice || 0)
      .input('QuantityOnHand', sql.Int, QuantityOnHand || 0)
      .input('ExpiryDate', sql.Date, ExpiryDate || null)
      .query(`INSERT INTO dbo.Medicines (SKU, Name, Manufacturer, UnitPrice, QuantityOnHand, ExpiryDate)
              OUTPUT INSERTED.*
              VALUES (@SKU, @Name, @Manufacturer, @UnitPrice, @QuantityOnHand, @ExpiryDate);`);
    res.status(201).json(insert.recordset[0]);
  } catch (err) {
    // handle uniqueness violation
    if (err && err.number === 2627) return res.status(409).json({ error: 'SKU must be unique' });
    handleError(res, err);
  }
});

/* PUT /medicines/:id - update metadata (not quantity) */
app.put('/medicines/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { Name, Manufacturer, UnitPrice, ExpiryDate } = req.body;
    const pool = await getPool();
    const upd = await pool.request()
      .input('id', sql.Int, id)
      .input('Name', sql.NVarChar(250), Name)
      .input('Manufacturer', sql.NVarChar(200), Manufacturer)
      .input('UnitPrice', sql.Decimal(10,2), UnitPrice)
      .input('ExpiryDate', sql.Date, ExpiryDate)
      .query(`UPDATE dbo.Medicines
              SET Name = COALESCE(@Name, Name),
                  Manufacturer = COALESCE(@Manufacturer, Manufacturer),
                  UnitPrice = COALESCE(@UnitPrice, UnitPrice),
                  ExpiryDate = @ExpiryDate,
                  UpdatedAt = SYSUTCDATETIME()
              WHERE MedicineID = @id;
              SELECT * FROM dbo.Medicines WHERE MedicineID = @id;`);
    if (upd.recordset.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(upd.recordset[0]);
  } catch (err) { handleError(res, err); }
});

/* DELETE /medicines/:id */
app.delete('/medicines/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    const del = await pool.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM dbo.Medicines WHERE MedicineID = @id; SELECT @@ROWCOUNT AS deleted;');
    if (del.recordset[0].deleted === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { handleError(res, err); }
});

/* POST /medicines/:id/adjust -> change quantity and log history
   body: { changeAmount: INT, reason: string, changedBy: string }
*/
app.post('/medicines/:id/adjust', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { changeAmount, reason, changedBy } = req.body;
    if (typeof changeAmount !== 'number' || changeAmount === 0) {
      return res.status(400).json({ error: 'changeAmount must be a non-zero number' });
    }

    const pool = await getPool();
    const trx = new sql.Transaction(pool);
    await trx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const request = trx.request();
      // check exists
      const cur = await request.input('id', sql.Int, id)
        .query('SELECT QuantityOnHand FROM dbo.Medicines WHERE MedicineID = @id;');

      if (cur.recordset.length === 0) {
        await trx.rollback();
        return res.status(404).json({ error: 'Medicine not found' });
      }

      const currentQty = cur.recordset[0].QuantityOnHand;
      const newQty = currentQty + changeAmount;
      if (newQty < 0) {
        await trx.rollback();
        return res.status(400).json({ error: 'Insufficient stock for this adjustment' });
      }

      // Update quantity
      await request.input('newQty', sql.Int, newQty)
        .query(`UPDATE dbo.Medicines
                SET QuantityOnHand = @newQty, UpdatedAt = SYSUTCDATETIME()
                WHERE MedicineID = @id;`);

      // Insert history
      await request.input('changeAmount', sql.Int, changeAmount)
        .input('reason', sql.NVarChar(500), reason || null)
        .input('changedBy', sql.NVarChar(200), changedBy || null)
        .query(`INSERT INTO dbo.MedicineStockHistory (MedicineID, ChangeAmount, Reason, ChangedBy)
                VALUES (@id, @changeAmount, @reason, @changedBy);`);

      await trx.commit();

      // Return updated row
      const updated = await pool.request().input('id', sql.Int, id)
        .query('SELECT * FROM dbo.Medicines WHERE MedicineID = @id;');

      res.json({ success: true, medicine: updated.recordset[0] });
    } catch (errTrx) {
      await trx.rollback();
      throw errTrx;
    }

  } catch (err) { handleError(res, err); }
});

/* GET /history/:medicineId - get stock history for a medicine */
app.get('/history/:medicineId', async (req, res) => {
  try {
    const id = parseInt(req.params.medicineId, 10);
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT * FROM dbo.MedicineStockHistory WHERE MedicineID = @id ORDER BY ChangedAt DESC;');
    res.json(result.recordset);
  } catch (err) { handleError(res, err); }
});

/* Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pharmacy API listening on http://localhost:${PORT}`);
});
