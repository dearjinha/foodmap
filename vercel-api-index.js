/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  인플루디오 맛집 지도 — Vercel Serverless Function           ║
 * ║  파일 위치: api/index.js                                     ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * 환경변수 (Vercel Dashboard → Project → Settings → Environment Variables):
 *   NOTION_TOKEN          = secret_xxxx
 *   NOTION_DB_ID          = 맛집 DB ID
 *   NOTION_COMMENTS_DB_ID = 댓글 DB ID
 *   NOTION_RATINGS_DB_ID  = 별점 DB ID
 *   KAKAO_REST_KEY        = 카카오 REST API 키
 *   ALLOWED_ORIGIN        = https://your-project.vercel.app
 *
 * 맛집 노션 DB 컬럼:
 *   Name(제목), Addr(텍스트), AddrDetail(텍스트), Cat(선택),
 *   Stars(숫자), Review(텍스트), Nick(텍스트),
 *   Lat(숫자), Lng(숫자), CreatedAt(텍스트), IsSeeded(체크박스), MapUrl(텍스트)
 *
 * 댓글 노션 DB 컬럼: PlaceId(제목), Nick(텍스트), Text(텍스트), CreatedAt(텍스트)
 * 별점 노션 DB 컬럼: PlaceId(제목), Nick(텍스트), Score(숫자)
 */

const NOTION    = 'https://api.notion.com/v1';
const KAKAO_API = 'https://dapi.kakao.com/v2/local';

export default async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = process.env.ALLOWED_ORIGIN || '*';

  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin',  allowed === '*' ? '*' : (origin.startsWith(allowed) ? origin : ''));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const { path, id, placeId, q } = req.query;
  const method = req.method;
  const body   = req.body;

  try {
    let result;
    // ── 맛집 ──
    if      (path==='places' && method==='GET')    result = await getPlaces();
    else if (path==='places' && method==='POST')   result = await addPlace(body);
    else if (path==='places' && method==='PATCH')  result = await updatePlace(id, body);
    else if (path==='places' && method==='DELETE') result = await deletePlace(id);
    // ── 댓글 ──
    else if (path==='comments' && method==='GET')    result = await getComments(placeId);
    else if (path==='comments' && method==='POST')   result = await addComment(body);
    else if (path==='comments' && method==='DELETE') result = await deleteComment(id);
    // ── 별점 ──
    else if (path==='ratings' && method==='GET')    result = await getRatings(placeId);
    else if (path==='ratings' && method==='POST')   result = await addRating(body);
    else if (path==='ratings' && method==='DELETE') result = await deleteRating(id);
    // ── 전체 조회 (빠른 로드) ──
    else if (path==='comments-all') result = await getAllComments();
    else if (path==='ratings-all')  result = await getAllRatings();
    // ── 카카오 검색 ──
    else if (path==='search')  result = await kakaoSearch(q);
    else if (path==='geocode') result = await kakaoGeocode(q);
    else return res.status(404).json({ error: 'Not found' });

    return res.status(200).json(result);
  } catch(e) {
    console.error('[foodmap]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── 맛집 CRUD ────────────────────────────────────────────
async function getPlaces() {
  const r = await nFetch(`/databases/${dbId()}/query`, 'POST', {
    sorts:[{property:'CreatedAt',direction:'descending'}], page_size:100,
  });
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return (d.results||[]).map(toPlace);
}

async function addPlace(body) {
  if((!body.lat||!body.lng) && body.addr) {
    const geo = await geocodeRaw(body.addr);
    if(geo) { body.lat=geo.lat; body.lng=geo.lng; }
  }
  const r = await nFetch('/pages','POST',{
    parent:{database_id:dbId()}, properties:toPlaceProps(body),
  });
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return toPlace(d);
}

async function updatePlace(pageId, body) {
  if(!pageId) throw new Error('id required');
  const r = await nFetch(`/pages/${pageId}`,'PATCH',{properties:toPlaceProps(body)});
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return toPlace(d);
}

async function deletePlace(pageId) {
  if(!pageId) throw new Error('id required');
  const r = await nFetch(`/pages/${pageId}`,'PATCH',{archived:true});
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return {success:true};
}

// ── 댓글 CRUD ────────────────────────────────────────────
async function getComments(placeId) {
  if(!placeId) return [];
  const r = await nFetch(`/databases/${commentsDbId()}/query`,'POST',{
    filter:{property:'PlaceId',title:{equals:placeId}},
    sorts:[{property:'CreatedAt',direction:'ascending'}], page_size:100,
  });
  const d = await r.json();
  if(!r.ok) return [];
  return (d.results||[]).map(toComment);
}

async function getAllComments() {
  const r = await nFetch(`/databases/${commentsDbId()}/query`,'POST',{
    sorts:[{property:'CreatedAt',direction:'ascending'}], page_size:100,
  });
  const d = await r.json();
  if(!r.ok) return [];
  return (d.results||[]).map(toComment);
}

async function addComment(body) {
  const r = await nFetch('/pages','POST',{
    parent:{database_id:commentsDbId()},
    properties:{
      PlaceId:  {title:    [{text:{content:body.placeId||''}}]},
      Nick:     {rich_text:[{text:{content:body.nick||''}}]},
      Text:     {rich_text:[{text:{content:body.text||''}}]},
      CreatedAt:{rich_text:[{text:{content:body.date||new Date().toLocaleDateString('ko-KR')}}]},
    },
  });
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return toComment(d);
}

async function deleteComment(pageId) {
  if(!pageId) throw new Error('id required');
  const r = await nFetch(`/pages/${pageId}`,'PATCH',{archived:true});
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return {success:true};
}

// ── 별점 CRUD ────────────────────────────────────────────
async function getRatings(placeId) {
  if(!placeId) return [];
  const r = await nFetch(`/databases/${ratingsDbId()}/query`,'POST',{
    filter:{property:'PlaceId',title:{equals:placeId}}, page_size:100,
  });
  const d = await r.json();
  if(!r.ok) return [];
  return (d.results||[]).map(toRating);
}

async function getAllRatings() {
  const r = await nFetch(`/databases/${ratingsDbId()}/query`,'POST',{page_size:100});
  const d = await r.json();
  if(!r.ok) return [];
  return (d.results||[]).map(toRating);
}

async function addRating(body) {
  const existing = await getRatings(body.placeId);
  const mine = existing.find(r => r.nick === body.nick);
  if(mine) await deleteRating(mine.id);
  const r = await nFetch('/pages','POST',{
    parent:{database_id:ratingsDbId()},
    properties:{
      PlaceId:{title:    [{text:{content:body.placeId||''}}]},
      Nick:   {rich_text:[{text:{content:body.nick||''}}]},
      Score:  {number:   Number(body.score)||0},
    },
  });
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return toRating(d);
}

async function deleteRating(pageId) {
  if(!pageId) throw new Error('id required');
  const r = await nFetch(`/pages/${pageId}`,'PATCH',{archived:true});
  const d = await r.json();
  if(!r.ok) throw new Error(d.message||JSON.stringify(d));
  return {success:true};
}

// ── 카카오 검색 ──────────────────────────────────────────
async function kakaoSearch(q) {
  if(!q) return [];
  const r = await fetch(
    `${KAKAO_API}/search/keyword.json?query=${enc(q)}&size=7`,
    {headers:{Authorization:`KakaoAK ${kakaoKey()}`}}
  );
  const d = await r.json();
  return (d.documents||[]).map(doc=>({
    name: doc.place_name,
    addr: doc.road_address_name||doc.address_name,
    lat:  parseFloat(doc.y),
    lng:  parseFloat(doc.x),
    mapUrl: doc.place_url,
  }));
}

async function kakaoGeocode(q) {
  if(!q) return {ok:false};
  const data = await geocodeRaw(q);
  return data ? {ok:true,...data} : {ok:false};
}

async function geocodeRaw(addr) {
  const r = await fetch(
    `${KAKAO_API}/search/address.json?query=${enc(addr)}`,
    {headers:{Authorization:`KakaoAK ${kakaoKey()}`}}
  );
  const d = await r.json();
  const doc = d.documents?.[0];
  if(!doc) return null;
  return {
    lat:  parseFloat(doc.y),
    lng:  parseFloat(doc.x),
    name: doc.address_name,
    addr: doc.address?.road_address?.address_name||doc.address_name,
  };
}

// ── Notion helpers ────────────────────────────────────────
const token        = () => process.env.NOTION_TOKEN;
const dbId         = () => process.env.NOTION_DB_ID;
const commentsDbId = () => process.env.NOTION_COMMENTS_DB_ID;
const ratingsDbId  = () => process.env.NOTION_RATINGS_DB_ID;
const kakaoKey     = () => process.env.KAKAO_REST_KEY;

function nFetch(endpoint, method, body) {
  return fetch(`${NOTION}${endpoint}`,{
    method,
    headers:{Authorization:`Bearer ${token()}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},
    body:JSON.stringify(body),
  });
}

function toPlace(page) {
  const p=page.properties||{};
  const txt=prop=>prop?.rich_text?.[0]?.plain_text||prop?.title?.[0]?.plain_text||'';
  const num=prop=>prop?.number??0;
  const sel=prop=>prop?.select?.name||'';
  return {
    id:page.id, name:txt(p.Name), addr:txt(p.Addr), addrDetail:txt(p.AddrDetail),
    cat:sel(p.Cat), stars:num(p.Stars), review:txt(p.Review), nick:txt(p.Nick),
    lat:num(p.Lat), lng:num(p.Lng), createdAt:txt(p.CreatedAt),
    isSeeded:p.IsSeeded?.checkbox??false, mapUrl:txt(p.MapUrl),
  };
}

function toPlaceProps(p) {
  return {
    Name:      {title:    [{text:{content:p.name||''}}]},
    Addr:      {rich_text:[{text:{content:p.addr||''}}]},
    AddrDetail:{rich_text:[{text:{content:p.addrDetail||''}}]},
    Cat:       {select:   {name:p.cat||'기타'}},
    Stars:     {number:   Number(p.stars)||3},
    Review:    {rich_text:[{text:{content:p.review||''}}]},
    Nick:      {rich_text:[{text:{content:p.nick||''}}]},
    Lat:       {number:   Number(p.lat)||0},
    Lng:       {number:   Number(p.lng)||0},
    CreatedAt: {rich_text:[{text:{content:p.createdAt||new Date().toLocaleDateString('ko-KR')}}]},
    IsSeeded:  {checkbox: Boolean(p.isSeeded)},
    MapUrl:    {rich_text:[{text:{content:p.mapUrl||''}}]},
  };
}

function toComment(page) {
  const p=page.properties||{};
  const txt=prop=>prop?.rich_text?.[0]?.plain_text||prop?.title?.[0]?.plain_text||'';
  return {id:page.id, placeId:txt(p.PlaceId), nick:txt(p.Nick), text:txt(p.Text), date:txt(p.CreatedAt)};
}

function toRating(page) {
  const p=page.properties||{};
  const txt=prop=>prop?.rich_text?.[0]?.plain_text||prop?.title?.[0]?.plain_text||'';
  return {id:page.id, placeId:txt(p.PlaceId), nick:txt(p.Nick), score:p.Score?.number||0};
}

const enc = s => encodeURIComponent(s);
