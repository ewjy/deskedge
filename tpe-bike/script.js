(function () {
  const proxyToggle = document.getElementById('proxyToggle');
  const reloadBtn = document.getElementById('reloadBtn');
  const statusMsg = document.getElementById('statusMsg');
  const dataTimeEl = document.getElementById('dataTime');
  const categorySelect = document.getElementById('categorySelect');
  const districtSelect = document.getElementById('districtSelect');
  const yearSelect = document.getElementById('yearSelect');
  const searchInput = document.getElementById('searchInput');
  const totalCountEl = document.getElementById('totalCount');
  const tableBody = document.querySelector('#resultTable tbody');

  const DATASETS = [
    {
      id: 'third-lane',
      label: '開放機車行駛第3車道',
      url: 'https://data.taipei/api/v1/dataset/a15f2a8d-eb1a-489d-a25f-3d816af10177?scope=resourceAquire',
      source: '臺北市開放機車行駛第3車道路段列表'
    },
    {
      id: 'two-lanes-two-stage',
      label: '二車道例外兩段式左轉管制',
      url: 'https://data.taipei/api/v1/dataset/86c7c859-78d4-430c-bada-277203abd881?scope=resourceAquire',
      source: '臺北市二車道路段例外實施兩段式左轉管制清冊'
    },
    {
      id: 'three-plus-direct-left',
      label: '三(含)車道以上直接左轉例外',
      url: 'https://data.taipei/api/v1/dataset/e77ab72d-cffa-46be-8b5c-16d60c32fce5?scope=resourceAquire',
      source: '臺北市三(含)車道以上例外開放機車直接左轉路口'
    }
  ];

  let RAW = [];
  let NORMALIZED = [];
  const CACHE_KEY = 'tp_moto_cache_v1';
  const PROXY_BASE = 'https://corsproxy.io/?';

  // Taipei administrative districts (12)
  const TAIPEI_DISTRICTS = [
    '中正區','大同區','中山區','松山區','大安區','萬華區',
    '信義區','士林區','北投區','內湖區','南港區','文山區'
  ];

  function detectDistrictsFromText(text) {
    const found = new Set();
    const hay = String(text || '');
    TAIPEI_DISTRICTS.forEach(d => {
      if (hay.includes(d)) found.add(d);
      const short = d.replace('區', '');
      if (short && hay.includes(short)) found.add(d);
    });
    return Array.from(found);
  }

  function tokenizeDistricts(str) {
    if (!str) return [];
    let s = String(str).replace(/[()（）]/g, ' ');
    s = s.replace(/[與跟及至到-]/g, ' ');
    return s.split(/[、，,／\/;；\s]+/).map(x => x.trim()).filter(Boolean);
  }

  function extractDistricts(rawDistrict, location, notes) {
    const rd = String(rawDistrict || '').trim();
    const text = `${rd} ${location || ''} ${notes || ''}`;

    // First, try direct detection from full text
    let list = detectDistrictsFromText(text);

    // If explicitly marked as spanning multiple districts but nothing detected,
    // try to split tokens and map to known districts
    if (list.length === 0) {
      const tokens = tokenizeDistricts(rd);
      const names = new Set(TAIPEI_DISTRICTS);
      const mapShortToFull = Object.fromEntries(TAIPEI_DISTRICTS.map(d => [d.replace('區',''), d]));
      tokens.forEach(t => {
        if (names.has(t)) list.push(t);
        else if (t.endsWith('區') && names.has(t)) list.push(t);
        else if (mapShortToFull[t]) list.push(mapShortToFull[t]);
        else if (t.endsWith('區') && mapShortToFull[t.replace('區','')]) list.push(mapShortToFull[t.replace('區','')]);
      });
    }

    list = Array.from(new Set(list));

    // Fallbacks
    if (list.length === 0) {
      if (rd && rd !== '跨越多個行政區' && rd !== '（未註明）') return [rd];
      // Still unknown → mark as not specified so it appears only when not filtering by district
      return ['（未註明）'];
    }
    return list;
  }

  function buildProxyUrl(useProxy, url) {
    if (!useProxy) return url;
    return PROXY_BASE + encodeURIComponent(url);
  }

  function appendParams(url, params) {
    const hasQ = url.includes('?');
    const sp = new URLSearchParams(hasQ ? url.split('?')[1] : '');
    Object.entries(params).forEach(([k, v]) => sp.set(k, String(v)));
    const base = hasQ ? url.split('?')[0] : url;
    return `${base}?${sp.toString()}`;
  }

  async function fetchDatasetAll(url, useProxy) {
    // Try paginated fetching (limit/offset). If API ignores params, guards stop looping.
    const pageSize = 1000;

    const fetchPage = async (offset) => {
      const u = appendParams(url, { limit: pageSize, offset });
      const proxied = buildProxyUrl(useProxy, u);
      const resp = await fetch(proxied, { cache: 'no-cache' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const result = json && (json.result || json.Result || json.data || json);
      if (!result) return { rows: [], count: undefined };

      let rows;
      if (Array.isArray(result.results)) rows = result.results;
      else if (Array.isArray(result.records)) rows = result.records;
      else if (Array.isArray(result)) rows = result;
      else {
        const key = Object.keys(result).find(k => Array.isArray(result[k]));
        rows = key ? result[key] : [];
      }
      const count = (typeof result.count === 'number') ? result.count : undefined;
      return { rows, count };
    };

    const first = await fetchPage(0);
    const all = [...first.rows];
    const total = first.count;
    let offset = all.length;
    let safety = 0;

    while (
      all.length < (total ?? Number.MAX_SAFE_INTEGER) &&
      safety < 200 &&
      (offset === 0 || (first.rows.length === pageSize))
    ) {
      const prevLen = all.length;
      const page = await fetchPage(offset);
      if (!page.rows || page.rows.length === 0) break;
      all.push(...page.rows);
      offset += page.rows.length;
      safety++;
      if (page.rows.length < pageSize) break;
      if (all.length === prevLen) break; // API ignored offset; avoid infinite loop
      if (total != null && all.length >= total) break;
    }

    return all;
  }

  function saveCache(payload) {
    const data = {
      version: 1,
      timestamp: new Date().toISOString(),
      normalized: NORMALIZED,
      raw: RAW,
      ...payload
    };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
  }

  function loadCache() {
    try {
      const s = localStorage.getItem(CACHE_KEY);
      if (!s) return null;
      const obj = JSON.parse(s);
      if (!obj || obj.version !== 1) return null;
      return obj;
    } catch { return null; }
  }

  function updateDataTime(ts) {
    if (!ts) { dataTimeEl.textContent = '—'; return; }
    try {
      const d = new Date(ts);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      dataTimeEl.textContent = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
    } catch {
      dataTimeEl.textContent = ts;
    }
  }

  function pickValue(obj, keys) {
    for (const k of keys) {
      if (k in obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
      // also try case-insensitive and fullwidth variations
      const found = Object.keys(obj).find(kk => kk.toLowerCase() === k.toLowerCase());
      if (found && obj[found] != null && String(obj[found]).trim() !== '') return String(obj[found]).trim();
    }
    return '';
  }

  function guessDistrict(obj) {
    const candidates = ['行政區', '行政區別', '行政區域', '區', '行政區名', '區別'];
    const value = pickValue(obj, candidates);
    if (value) return value;
    // heuristic: any key ending with 區 or 含 區
    const k = Object.keys(obj).find(kk => /區$|行政/.test(kk));
    return k ? String(obj[k]).trim() : '';
  }

  function guessLocation(obj) {
    const candidates = ['路段', '路名', '道路名稱', '地點', '位置', '路口', '起訖', '主要路段', '主要路口'];
    const value = pickValue(obj, candidates);
    if (value) return value;
    // Combine a couple likely fields if exist
    const a = pickValue(obj, ['道路名稱', '路名']);
    const b = pickValue(obj, ['路段', '路口', '地點']);
    if (a && b) return `${a} ${b}`.trim();
    return a || b || '';
  }

  function guessNotes(obj) {
    const candidates = ['備註', '說明', '備考', '備註說明'];
    const value = pickValue(obj, candidates);
    if (value) return value;
    // else, empty
    return '';
  }

  function rocToAD(rocYear) {
    return rocYear + 1911;
  }

  function extractYear(obj) {
    // Try common year field names - try exact match first
    const candidates = ['年份', '實施年份', '實施日期', '公告年份', '開放年份', '管制年份', '年度'];
    let text = pickValue(obj, candidates);
    
    // Also check notes and other string fields
    if (!text) {
      const allText = Object.values(obj).filter(v => typeof v === 'string').join(' ');
      text = allText;
    }
    
    if (!text) return { year: null, period: 'unknownFrom2009', display: '2009年起（具體年份不明）' };
    
    // Pattern matching for ROC years
    // "97年以前" or "98年以前" -> before2009
    if (/9[0-8]年?以前/.test(text) || /9[0-8]年?前/.test(text)) {
      return { year: null, period: 'before2009', display: '2009年以前' };
    }
    
    // "98-101年間" or range - display converted range, categorize as unknownFrom2009
    const rangeMatch = text.match(/(9[89]|1[0-9]{2})[-~至到](9[89]|1[0-9]{2})年?[間期]?/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      const startAD = rocToAD(start);
      const endAD = rocToAD(end);
      const period = startAD < 2009 ? 'before2009' : 'unknownFrom2009';
      return { 
        year: startAD, 
        period,
        display: `${startAD}-${endAD}年間`
      };
    }
    
    // Single ROC year like "98年", "101年" - specific year
    const singleMatch = text.match(/([89][0-9]|1[0-9]{2})年/);
    if (singleMatch) {
      const roc = parseInt(singleMatch[1]);
      const ad = rocToAD(roc);
      return { 
        year: ad, 
        period: ad < 2009 ? 'before2009' : `year_${ad}`,
        display: `${ad}年`
      };
    }
    
    // AD year 2000+ - specific year
    const adMatch = text.match(/(20[0-9]{2})年/);
    if (adMatch) {
      const ad = parseInt(adMatch[1]);
      return { 
        year: ad, 
        period: ad < 2009 ? 'before2009' : `year_${ad}`,
        display: `${ad}年`
      };
    }
    
    // Numeric-only ROC year (no '年' character) - like "98", "101", "102" - specific year
    const numOnly = text.match(/^([89][0-9]|1[0-9]{2})$/);
    if (numOnly) {
      const roc = parseInt(numOnly[1]);
      const ad = rocToAD(roc);
      return { 
        year: ad, 
        period: ad < 2009 ? 'before2009' : `year_${ad}`,
        display: `${ad}年`
      };
    }
    
    return { year: null, period: 'unknownFrom2009', display: '2009年起（具體年份不明）' };
  }

  function normalizeRecord(categoryLabel, source, obj) {
    const rawDistrict = guessDistrict(obj) || '';
    const location = guessLocation(obj) || '（未註明）';
    const notes = guessNotes(obj);
    const districts = extractDistricts(rawDistrict, location, notes)
      .filter(d => d !== '跨越多個行政區');

    // Display district string: keep CSV/original style if present; otherwise join detected
    const displayDistrict = rawDistrict && rawDistrict.trim()
      ? rawDistrict.trim()
      : (districts.length ? districts.join('、') : '（未註明）');

    const yearInfo = extractYear(obj);

    return {
      category: categoryLabel,
      district: displayDistrict,
      districts,
      location,
      notes,
      year: yearInfo.year,
      yearPeriod: yearInfo.period,
      yearDisplay: yearInfo.display || '—',
      source,
      raw: obj
    };
  }

  function uniqueSorted(arr) {
    return Array.from(new Set(arr.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-Hant')); 
  }

  function populateFilters() {
    // Category options: fixed from DATASETS
    categorySelect.innerHTML = '<option value="">全部</option>' +
      DATASETS.map(d => `<option value="${d.label}">${d.label}</option>`).join('');

    // District options from data
    const districts = uniqueSorted(NORMALIZED.flatMap(r => r.districts || [])
      .filter(d => d && d !== '跨越多個行政區'));
    districtSelect.innerHTML = '<option value="">全部</option>' +
      districts.map(x => `<option value="${x}">${x}</option>`).join('');

    // Year options: before2009, individual years 2009+, unknownFrom2009
    const periods = new Set(NORMALIZED.map(r => r.yearPeriod).filter(Boolean));
    const years = [];
    periods.forEach(p => {
      if (p.startsWith('year_')) {
        const y = parseInt(p.replace('year_', ''));
        if (y >= 2009) years.push(y);
      }
    });
    years.sort((a, b) => a - b);

    let yearOptions = '<option value="">全部</option>';
    if (periods.has('before2009')) {
      yearOptions += '<option value="before2009">2009年以前</option>';
    }
    years.forEach(y => {
      yearOptions += `<option value="year_${y}">${y}年</option>`;
    });
    if (periods.has('unknownFrom2009')) {
      yearOptions += '<option value="unknownFrom2009">2009年起（具體年份不明）</option>';
    }
    yearSelect.innerHTML = yearOptions;
  }

  function applyFilters() {
    const cat = categorySelect.value;
    const dist = districtSelect.value;
    const year = yearSelect.value;
    const q = searchInput.value.trim();
    const qlc = q.toLowerCase();

    let rows = NORMALIZED;
    if (cat) rows = rows.filter(r => r.category === cat);
    if (dist) rows = rows.filter(r => Array.isArray(r.districts) && r.districts.includes(dist));
    if (year) rows = rows.filter(r => r.yearPeriod === year);
    if (q) rows = rows.filter(r =>
      r.location.toLowerCase().includes(qlc) ||
      r.district.toLowerCase().includes(qlc)
    );

    renderTable(rows);
  }

  function renderTable(rows) {
    totalCountEl.textContent = rows.length.toString();
    const frag = document.createDocumentFragment();
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="管制類別"><span class="badge">${escapeHtml(r.category)}</span></td>
        <td data-label="行政區">${escapeHtml(r.district)}</td>
        <td data-label="地點/路段">${escapeHtml(r.location)}</td>
        <td data-label="實施年份">${escapeHtml(r.yearDisplay)}</td>
        <td data-label="來源"><a class="source-link" href="#" title="查看原始欄位" data-tooltip>來源</a></td>
      `;
      const link = tr.querySelector('a.source-link');
      link.addEventListener('click', (e) => {
        e.preventDefault();
        alert(JSON.stringify(r.raw, null, 2));
      });
      frag.appendChild(tr);
    });
    tableBody.innerHTML = '';
    tableBody.appendChild(frag);
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function loadAll({ useProxy, forceRefresh }) {
    tableBody.innerHTML = '';
    totalCountEl.textContent = '0';

    // Use cache when not forcing refresh
    if (!forceRefresh) {
      const cached = loadCache();
      if (cached && Array.isArray(cached.normalized) && cached.normalized.length) {
        NORMALIZED = cached.normalized;
        RAW = cached.raw || [];
        populateFilters();
        applyFilters();
        statusMsg.textContent = `已載入快取（共 ${NORMALIZED.length} 筆）`;
        updateDataTime(cached.timestamp);
        return;
      }
    }

    statusMsg.textContent = '資料載入中...';
    updateDataTime(null);
    RAW = [];
    NORMALIZED = [];

    let lastError = null;
    for (const ds of DATASETS) {
      try {
        const rows = await fetchDatasetAll(ds.url, useProxy);
        RAW.push({ id: ds.id, label: ds.label, source: ds.source, rows });
        const mapped = rows.map(r => normalizeRecord(ds.label, ds.source, r));
        NORMALIZED.push(...mapped);
      } catch (err) {
        lastError = err;
        console.error('Fetch error for', ds.id, err);
      }
    }

    if (NORMALIZED.length === 0 && lastError) {
      statusMsg.textContent = `載入失敗：${lastError.message}。請稍後再試或開啟 CORS Proxy 後重試。`;
      return;
    }

    // Save cache
    saveCache({});

    // Populate UI and render
    populateFilters();
    applyFilters();
    statusMsg.textContent = `載入完成（共 ${NORMALIZED.length} 筆，${DATASETS.length} 組資料）`;
    const cached = loadCache();
    updateDataTime(cached?.timestamp);
  }

  // Events
  [categorySelect, districtSelect, yearSelect].forEach(el => el.addEventListener('change', applyFilters));
  searchInput.addEventListener('input', applyFilters);
  reloadBtn.addEventListener('click', () => loadAll({ useProxy: proxyToggle.checked, forceRefresh: true }));
  proxyToggle.addEventListener('change', () => {
    document.getElementById('proxyLabel').textContent = proxyToggle.checked ? '開' : '關';
  });

  // Initial load
  loadAll({ useProxy: proxyToggle.checked, forceRefresh: false });
})();
