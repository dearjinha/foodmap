/**
 * Netlify Serverless Function — 노션 DB 프록시
 *
 * 환경변수:
 *   NOTION_TOKEN          = secret_xxxx
 *   NOTION_DB_ID          = 맛집 DB ID (32자리)
 *   NOTION_COMMENTS_DB_ID = 댓글 DB ID (32자리)
 *   ALLOWED_ORIGIN        = https://infludeo-foodmap.netlify.app
 *
 * 댓글 노션 DB 컬럼:
 *   PlaceId(제목), Nick(텍스트), Text(텍스트), CreatedAt(텍스트)
 */

const NOTION    = 'https://api.notion.com/v1';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

exports.handler = async (event) => {
  const origin  = event.headers.origin || event.headers.Origin || '';
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  const cors = {
    'Access-Control-Allow-Origin':  allowed === '*' ? '*' : (origin.startsWith(allowed) ? origin : ''),
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers:cors, body:'' };

  const q      = event.queryStringParameters || {};
  const path   = q.path  || '';
  const method = event.httpMethod;

  try {
    let result;
    // ── 맛집 ──
    if      (path==='places' && method==='GET')    result = await getPlaces();
    else if (path==='places' && method==='POST')   result = await addPlace(JSON.parse(event.body||'{}'));
    else if (path==='places' && method==='PATCH')  result = await updatePlace(q.id, JSON.parse(event.body||'{}'));
    else if (path==='places' && method==='DELETE') result = await deletePlace(q.id);
    // ── 댓글 ──
    else if (path==='comments' && method==='GET')    result = await getComments(q.placeId);
    else if (path==='comments' && method==='POST')   result = await addComment(JSON.parse(event.body||'{}'));
    else if (path==='comments' && method==='DELETE') result = await deleteComment(q.id);
    // ── 검색 ──
    else if (path==='search')  result = await search(q.q);
    else if (path==='geocode') result = await geocode(q.q);
    else return res(404, {error:'Not found'}, cors);
    return res(200, result, cors);
  } catch(e) {
    console.error('[foodmap]', e.message);
    return res(500, {error:e.message}, cors);
  }
};

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
  if((!body.lat||!body.lng)&&body.addr){
    const geo = await geocodeRaw(body.addr);
    if(geo){body.lat=geo.lat;body.lng=geo.lng;}
  }
  const r = await nFetch('/pages','POST',{
    parent:{database_id:dbId()},
    properties:toPlaceProps(body),
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
    sorts:[{property:'CreatedAt',direction:'ascending'}],
    page_size:100,
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

function toComment(page) {
  const p = page.properties||{};
  const txt = prop => prop?.rich_text?.[0]?.plain_text||prop?.title?.[0]?.plain_text||'';
  return { id:page.id, placeId:txt(p.PlaceId), nick:txt(p.Nick), text:txt(p.Text), date:txt(p.CreatedAt) };
}

// ── Nominatim ────────────────────────────────────────────
async function search(q) {
  if(!q) return [];
  const url=`${NOMINATIM}/search?q=${enc(q)}&format=json&limit=6&accept-language=ko&countrycodes=kr`;
  const r = await fetch(url,{headers:{'User-Agent':'FoodmapInternal/1.0'}});
  const d = await r.json();
  return (d||[]).map(item=>({
    name:item.display_name.split(',')[0].trim(),
    addr:item.display_name,
    lat:parseFloat(item.lat),
    lng:parseFloat(item.lon),
  }));
}
async function geocode(q) {
  if(!q) return {ok:false};
  const data = await geocodeRaw(q);
  return data?{ok:true,...data}:{ok:false};
}
async function geocodeRaw(q) {
  const url=`${NOMINATIM}/search?q=${enc(q)}&format=json&limit=1&accept-language=ko`;
  const r = await fetch(url,{headers:{'User-Agent':'FoodmapInternal/1.0'}});
  const d = await r.json();
  if(!d?.[0]) return null;
  return {lat:parseFloat(d[0].lat),lng:parseFloat(d[0].lon),name:d[0].display_name.split(',')[0].trim(),addr:d[0].display_name};
}

// ── Notion helpers ────────────────────────────────────────
const token       = () => process.env.NOTION_TOKEN;
const dbId        = () => process.env.NOTION_DB_ID;
const commentsDbId= () => process.env.NOTION_COMMENTS_DB_ID;

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
  return {id:page.id,name:txt(p.Name),addr:txt(p.Addr),addrDetail:txt(p.AddrDetail),
    cat:sel(p.Cat),stars:num(p.Stars),review:txt(p.Review),nick:txt(p.Nick),
    lat:num(p.Lat),lng:num(p.Lng),createdAt:txt(p.CreatedAt),isSeeded:p.IsSeeded?.checkbox??false};
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
  };
}

const enc = s => encodeURIComponent(s);
const res = (statusCode, data, headers) => ({
  statusCode, headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify(data),
});
