
  const token = localStorage.getItem('token')
  let pendingToken = ''
  let phoneDigits = ''

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'bypass-tunnel-reminder': '1', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    return res.json()
  }

  function showMsg(text, ok = false) {
    const el = document.getElementById('msg')
    el.textContent = text
    el.className = 'msg show ' + (ok ? 'ok' : 'err')
  }

  function hideMsg() {
    document.getElementById('msg').className = 'msg'
  }

  function showStep(name) {
    hideMsg()
    for (const el of document.querySelectorAll('.step')) el.classList.remove('active')
    document.getElementById('step-' + name).classList.add('active')
  }

  async function init() {
    if (!token) return location.replace('/')
    try {
      const data = await api('GET', '/api/discord/me')
      if (!data.success) {
        localStorage.clear()
        return location.replace('/')
      }
      if (data.linked) return location.replace('/profile')
      document.getElementById('avatar').src = data.discord.avatar
      document.getElementById('name').textContent = data.discord.name
      document.getElementById('sub').textContent = `${data.discord.exp} EXP · ${data.discord.limit} limit`
      showStep(data.whatsappAvailable ? 'phone' : 'unavailable')
    } catch {
      showStep('unavailable')
      showMsg('Could not reach the server. Please reload the page.')
    }
  }

  async function sendCode() {
    const btn = document.getElementById('send-btn')
    const phone = document.getElementById('phone').value.replace(/\D/g, '')
    const password = document.getElementById('password').value
    if (!phone || !password) return showMsg('Enter your number and password.')
    btn.disabled = true
    hideMsg()
    try {
      const data = await api('POST', '/api/discord/connect', { phone, password })
      if (!data.success) return showMsg(data.message || 'Failed to send the code.')
      pendingToken = data.pendingToken
      phoneDigits = data.phone || phone
      showStep('code')
      showMsg('Code sent to your WhatsApp.', true)
    } catch {
      showMsg('Could not reach the server. Please try again.')
    } finally {
      btn.disabled = false
    }
  }

  async function verifyCode() {
    const btn = document.getElementById('verify-btn')
    const code = document.getElementById('code').value.trim()
    if (code.length !== 6) return showMsg('Enter the 6 digit code.')
    btn.disabled = true
    hideMsg()
    try {
      const data = await api('POST', '/api/discord/verify', { phone: phoneDigits, pendingToken, code })
      if (!data.success) return showMsg(data.message || 'Verification failed.')
      localStorage.setItem('token', data.token)
      localStorage.setItem('phone', data.phone || phoneDigits)
      showMsg('Accounts connected.', true)
      setTimeout(() => location.replace('/profile'), 600)
    } catch {
      showMsg('Could not reach the server. Please try again.')
    } finally {
      btn.disabled = false
    }
  }

  async function resendCode() {
    hideMsg()
    try {
      const data = await api('POST', '/api/resend-otp', { phone: phoneDigits })
      if (!data.success) return showMsg(data.message || 'Failed to resend the code.')
      pendingToken = data.pendingToken
      showMsg('Code resent.', true)
    } catch {
      showMsg('Could not reach the server. Please try again.')
    }
  }

  init()
