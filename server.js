require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DATA_FILE = path.join(__dirname, 'data.json');

if (!API_KEY) {
  console.warn('⚠️  تحذير: لم يتم ضبط ANTHROPIC_API_KEY في ملف .env — ميزة تحليل الوصولات لن تعمل.');
}

app.use(express.json({ limit: '15mb' })); // receipts as base64 need a larger limit
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Data persistence (shared DB: promoters/orders/inventory) ---------- */
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { promoters: [], orders: [], inventory: [] };
  }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/data', (req, res) => {
  res.json(readData());
});

app.post('/api/data', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'بيانات غير صالحة' });
  }
  try {
    writeData(body);
    res.json({ ok: true });
  } catch (e) {
    console.error('write error', e);
    res.status(500).json({ error: 'تعذّر حفظ البيانات على السيرفر' });
  }
});

/* ---------- Receipt extraction (secure server-side Anthropic call) ---------- */
app.post('/api/extract-receipt', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'لم يتم ضبط مفتاح الذكاء الاصطناعي على السيرفر (ANTHROPIC_API_KEY)' });
  }
  const { image, mediaType } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: 'لم يتم استلام صورة' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    'هذه صورة وصل قبض أو فاتورة بيع جهاز. استخرج البيانات التالية وأعد النتيجة بصيغة JSON فقط بدون أي نص إضافي وبدون Markdown:\n' +
    '{\n' +
    '  "date": "YYYY-MM-DD (تاريخ الوصل إن وُجد، وإلا استخدم ' + today + ')",\n' +
    '  "deviceName": "اسم الجهاز أو المنتج",\n' +
    '  "quantity": رقم صحيح (الكمية، افتراضي 1 إن لم تُذكر),\n' +
    '  "unitPrice": رقم (سعر الوحدة بالدينار العراقي، احسبه من الإجمالي إذا لزم),\n' +
    '  "customerName": "اسم الزبون إن وُجد وإلا نص فارغ",\n' +
    '  "region": "المنطقة/العنوان إن وُجد وإلا نص فارغ"\n' +
    '}\n' +
    'إذا لم تستطع قراءة حقل ما بثقة، استخدم قيمة فارغة أو صفر بدلاً من التخمين.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'فشل الاتصال بخدمة التحليل' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'لم يتم استلام نتيجة من خدمة التحليل' });
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'تعذّر فهم بيانات الوصل، جرّب صورة أوضح' });
    }

    res.json(parsed);
  } catch (e) {
    console.error('extract-receipt error', e);
    res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء التحليل' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ كاش فان يعمل على http://localhost:${PORT}`);
});
