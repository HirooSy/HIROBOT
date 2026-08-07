import https from 'https';
import dns from 'dns';
import querystring from 'querystring';
import axios from 'axios';

dns.setServers(['8.8.8.8', '1.1.1.1']);

function customLookup(hostname, opts, callback) {
  dns.resolve4(hostname, (err, addresses) => {
    if (err || !addresses || addresses.length === 0) {
      dns.lookup(hostname, opts, callback);
    } else {
      if (opts.all) {
        callback(null, addresses.map(ip => ({ address: ip, family: 4 })));
      } else {
        callback(null, addresses[0], 4);
      }
    }
  });
}

function makeRequest(urlStr, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      lookup: customLookup,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...headers
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractVideoId(url) {
  if (typeof url === 'string' && url.length === 11 && /^[\w-]+$/.test(url)) return url;
  const match = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return match ? match[1] : null;
}

async function fetchMetadata(videoId) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await makeRequest(oembedUrl, 'GET');
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      return {
        title: data.title || '',
        author: data.author_name || '',
        thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    }
  } catch (_) {}
  return { title: '', author: '', thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` };
}

const VALID_MP4_QUALITY = [1080, 720, 480, 360, 240, 144];
const VALID_MP3_QUALITY = [320, 256, 128];

export async function ytdl(type, url, quality) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL or Video ID');

  const isAudio = type === 'audio';
  const format = isAudio ? 'mp3' : 'mp4';

  let q = quality;
  if (isAudio) {
    q = VALID_MP3_QUALITY.includes(q) ? q : 320;
  } else {
    q = VALID_MP4_QUALITY.includes(q) ? q : 480;
  }

  const meta = await fetchMetadata(videoId);

  const keyHeaders = {
    'Content-Type': 'application/json',
    'Origin': 'https://frame.y2meta-uk.com',
    'Referer': `https://frame.y2meta-uk.com/wwwindex.php?videoId=${videoId}`
  };
  const keyRes = await makeRequest('https://cnv.cx/v2/sanity/key', 'GET', keyHeaders);
  if (keyRes.statusCode !== 200) {
    throw new Error(`Sanity key API returned HTTP status ${keyRes.statusCode}`);
  }
  const keyData = JSON.parse(keyRes.body);
  const sanityKey = keyData.key;
  if (!sanityKey) throw new Error('Key not found in sanity check response');

  const audioBitrate = !isAudio ? 128 : q;
  const videoQuality = isAudio ? 720 : q;

  const convertBody = querystring.stringify({
    link: 'https://youtu.be/' + videoId,
    format,
    audioBitrate,
    videoQuality,
    filenameStyle: 'pretty',
    vCodec: 'h264'
  });

  const convertHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'accept': '*/*',
    'key': sanityKey,
    'Content-Length': Buffer.byteLength(convertBody),
    'Origin': 'https://frame.y2meta-uk.com',
    'Referer': `https://frame.y2meta-uk.com/wwwindex.php?videoId=${videoId}`
  };

  const convertRes = await makeRequest('https://cnv.cx/v2/converter', 'POST', convertHeaders, convertBody);
  if (convertRes.statusCode !== 200) {
    throw new Error(`Converter API returned HTTP status ${convertRes.statusCode}`);
  }

  let convertData;
  try {
    convertData = JSON.parse(convertRes.body);
  } catch (_) {
    convertData = {};
  }

  let downloadUrl = convertData && convertData.url;
  let rawFilename = (convertData && convertData.filename) || `${videoId}.${format}`;

  if (!downloadUrl) {
    downloadUrl = 'https://conv.mp3youtube.cc/download/' + videoId;
  }

  const fileRes = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    maxRedirects: 10
  });

  const buffer = Buffer.from(fileRes.data);
  const mime = isAudio ? 'audio/mpeg' : 'video/mp4';

  return {
    buffer,
    mime,
    title: meta.title || rawFilename.replace(/\.[^/.]+$/, ''),
    author: meta.author || '',
    duration: convertData.duration || '',
    views: convertData.views || 0,
    thumbnail: meta.thumbnail || null,
    quality: q,
    url: 'https://youtu.be/' + videoId
  };
}

export default { ytdl };
