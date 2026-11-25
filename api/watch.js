export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { action, token, route, fare } = req.query;

  const SECRET = process.env.WATCH_SECRET || 'kmb888';
  const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'homestocktake';
  const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyAwleOsALATtT61-J0QLq41LD3dKghD0aE';
  const PASS_COST = 834;

  if (token !== SECRET) {
    return res.status(401).send('❌ 驗證失敗：Token 錯誤');
  }

  try {
    // ====================================================
    // 動作 1：一鍵查詢所有已儲存車站的實時到站 (給手錶看)
    // ====================================================
    if (action === 'eta') {
      const configUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/settings/user_routes?key=${API_KEY}`;
      const configRes = await fetch(configUrl);
      const configData = await configRes.json();

      if (!configData.fields?.list?.arrayValue?.values) {
        return res.status(200).send('⚠️ 請先在 iPhone 網頁版新增常用車站！');
      }

      const routes = configData.fields.list.arrayValue.values.map(v => {
        const f = v.mapValue.fields;
        return {
          route: f.route?.stringValue || '',
          stopId: f.stopId?.stringValue || '',
          stopName: f.stopName?.stringValue || '',
          dir: f.dir?.stringValue || 'O'
        };
      });

      const now = new Date();
      const results = await Promise.all(routes.map(async (r) => {
        if (!r.stopId || !r.route) return null;
        try {
          const kmbRes = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/eta/${r.stopId}/${r.route}/1`);
          const kmbJson = await kmbRes.json();
          const times = (kmbJson.data || [])
            .filter(d => d.dir === r.dir && d.eta)
            .slice(0, 3)
            .map(d => {
              const mins = Math.max(0, Math.round((new Date(d.eta) - now) / 60000));
              return mins === 0 ? '即到' : `${mins}分`;
            });

          const timeStr = times.length > 0 ? times.join('、') : '暫無班次';
          return `🚌 ${r.route} (${r.stopName})：${timeStr}`;
        } catch {
          return `🚌 ${r.route}：查詢逾時`;
        }
      }));

      const reply = results.filter(Boolean).join('\n');
      return res.status(200).send(reply || '未設定有效車站');
    }

    // ====================================================
    // 動作 2：Apple Watch 打卡記帳 + 回傳最新回本進度
    // ====================================================
    if (action === 'log') {
      const numFare = parseFloat(fare);
      if (!route || isNaN(numFare)) {
        return res.status(400).send('❌ 參數錯誤：請提供 route 與 fare');
      }

      const hkDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
      const currentMonth = `${hkDate.getFullYear()}-${String(hkDate.getMonth() + 1).padStart(2, '0')}`;

      const addUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/trips?key=${API_KEY}`;
      await fetch(addUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            month: { stringValue: currentMonth },
            route: { stringValue: route.toUpperCase() },
            fare: { doubleValue: numFare },
            createdAt: { timestampValue: new Date().toISOString() }
          }
        })
      });

      const queryUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery?key=${API_KEY}`;
      const queryRes = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'trips' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'month' },
                op: 'EQUAL',
                value: { stringValue: currentMonth }
              }
            }
          }
        })
      });

      const docs = await queryRes.json();
      let totalFare = 0;
      docs.forEach(d => {
        if (d.document?.fields?.fare) {
          totalFare += (d.document.fields.fare.doubleValue || d.document.fields.fare.integerValue || 0);
        }
      });

      const diff = (totalFare - PASS_COST).toFixed(1);
      const statusMsg = totalFare >= PASS_COST
        ? `🎉 已回本！淨賺 $${diff}`
        : `⏳ 仲差 $${Math.abs(diff)} 回本`;

      return res.status(200).send(`✅ 已記 ${route.toUpperCase()} ($${numFare})\n💰 本月累計：$${totalFare.toFixed(1)}\n${statusMsg}`);
    }

    return res.status(400).send('❌ 無效的 action 參數');
  } catch (err) {
    return res.status(500).send(`❌ 系統錯誤: ${err.message}`);
  }
}
