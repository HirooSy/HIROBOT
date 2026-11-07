import axios from 'hiro/axios'

const base = 'https://salman555-upscale-images.hf.space'

async function uploadToGradio(buffer) {
  const form = new FormData()
  form.append('files', new Blob([buffer], { type: 'image/jpeg' }), 'input.jpg')

  const uploadRes = await axios.post(`${base}/gradio_api/upload`, form, {
    timeout: 60000
  })

  return uploadRes.data[0]
}

async function runUpscale(uploadedPath, api_name) {
  const session_hash = Math.random().toString(36).substring(2)

  const payload = {
    data: [
      {
        path: uploadedPath,
        url: `${base}/gradio_api/file=${uploadedPath}`,
        orig_name: 'input.jpg',
        size: null,
        mime_type: 'image/jpeg',
        is_stream: false,
        meta: { _type: 'gradio.FileData' }
      }
    ],
    event_data: null,
    fn_index: api_name === 'upscale_x2' ? 0 : api_name === 'standard_upscale' ? 1 : 2,
    trigger_id: null,
    session_hash
  }

  const joinRes = await axios.post(`${base}/gradio_api/queue/join`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000
  })
  const event_id = joinRes.data.event_id

  const sseRes = await axios.get(`${base}/gradio_api/queue/data`, {
    params: { session_hash },
    responseType: 'text',
    timeout: 300000,
    headers: { Accept: 'text/event-stream' },
    transformResponse: [(data) => data]
  })

  const raw = sseRes.data
  const lines = raw.split('\n').filter(l => l.startsWith('data: '))

  let completedEvent = null
  for (const line of lines) {
    try {
      const json = JSON.parse(line.slice(6))
      if (json.event_id === event_id && json.msg === 'process_completed') {
        completedEvent = json
      }
    } catch (e) {
    }
  }

  if (!completedEvent) throw new Error('No result received from server (timeout/SSE disconnected)')
  if (!completedEvent.success) throw new Error('Server failed to process the image')

  const outputData = completedEvent.output?.data
  if (!outputData || !outputData[0]) {
    throw new Error('Result format is not as expected')
  }

  const fileData = outputData[0]
  return fileData.url
}

export { uploadToGradio, runUpscale, downloadResult }
async function downloadResult(url) {
  return axios.get(url, { responseType: 'arraybuffer', timeout: 120000 })
}
