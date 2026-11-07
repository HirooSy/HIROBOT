import axios from 'hiro/axios'
import crypto from 'crypto'

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.designkit.cn/quality',
  'Origin': 'https://www.designkit.cn'
}

export async function enhance(imageInput) {
  if (!imageInput) throw new Error('Image input is required (URL or local file path).')

  let buf = null
  if (typeof imageInput === 'string' && imageInput.startsWith('http')) {
    const res = await axios.get(imageInput, { responseType: 'arraybuffer', timeout: 25000 })
    buf = Buffer.from(res.data)
  }
  if (!buf && Buffer.isBuffer(imageInput)) {
    buf = imageInput
  }
  if (!buf) {
    throw new Error('Failed to read image file/URL.')
  }

  const policyRes = await axios.get('https://strategy.app.meitudata.com/upload/policy?app=xiuxiu-pro&count=1&suffix=jpeg&type=ai_quality', {
    headers: headers,
    timeout: 15000
  })

  const qiniu = policyRes.data?.[0]?.qiniu
  if (!qiniu?.token) throw new Error('Failed to get upload token.')

  const form = new FormData()
  form.append('token', qiniu.token)
  if (qiniu.key) form.append('key', qiniu.key)
  form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'image.jpg')

  const upRes = await fetch('https://up-qagw.meitudata.com/', { method: 'POST', body: form })
  const upData = await upRes.json()
  const cloudUrl = upData?.data
  if (!cloudUrl) throw new Error('Failed to upload image to Meitu cloud.')

  const gid = '1a08f8' + crypto.randomBytes(6).toString('hex')
  const taskRes = await axios.post(`https://webapi.designkit.cn/v3/mtlab/image_restoration_async?gid=${gid}`, {
    parameter: {
      rsp_media_type: 'url',
      custom_size_flag: 1,
      create_value: 100,
      hdr_value: 0,
      resemblance_value: 80,
      save_photo_format: 1
    },
    media_info_list: [{ media_data: cloudUrl, media_extra: {}, media_profiles: { media_data_type: 'url' } }],
    extra: {}
  }, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 15000
  })

  const msgId = taskRes.data?.data?.msg_id || taskRes.data?.msg_id
  if (!msgId) throw new Error('Failed to create AI task.')

  let resultInfo = null
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1200))
    const qRes = await axios.get(`https://webapi.designkit.cn/v1/mtlab/query_multi?msg_ids=${msgId}`, {
      headers: headers,
      timeout: 15000
    })
    const media = qRes.data?.data?.[0]?.media_info_list?.[0]
    if (media?.media_data) {
      resultInfo = media
      break
    }
  }

  if (!resultInfo?.media_data) {
    throw new Error('Proses AI timeout.')
  }

  return {
    status: true,
    url: resultInfo.media_data,
    width: resultInfo.media_profiles?.media_data_width || null,
    height: resultInfo.media_profiles?.media_data_height || null,
    size_bytes: resultInfo.media_profiles?.media_data_size || null
  }
}

async function downloadResult(url) {
    return axios.get(url, { responseType: 'arraybuffer', timeout: 120000 })
}

export { downloadResult }
