
  function showModal(message) {
    const modal = document.getElementById('modal');
    const modalBody = document.getElementById('modal-body');
    modalBody.textContent = message || 'This number is not listed in the database';
    modal.classList.add('show');
  }

  function closeModal() {
    const modal = document.getElementById('modal');
    modal.classList.remove('show');
  }

  function formatPhoneNumber(input) {
    let cleaned = input.value.replace(/\D/g, '');
    input.value = cleaned;
  }
  
  document.addEventListener('DOMContentLoaded', () => {
    const phoneInputs = ['login-phone', 'register-phone'];
    phoneInputs.forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('input', function() { formatPhoneNumber(this); });
        input.addEventListener('blur', function() { formatPhoneNumber(this); });
      }
    });
    loadBotName();
  });

  async function loadBotName() {
    try {
      const res = await safeFetch('/api/botInfo')
      const data = await res.json()
      if (data && data.icon) {
        document.getElementById('favicon').href = data.icon
        document.querySelectorAll('.brand-icon img').forEach(img => img.src = data.icon)
      }
      if (data && data.name) {
        document.title = data.name
        document.getElementById('brand-title-modal').textContent = data.name
        document.querySelectorAll('.brand-icon img').forEach(img => img.alt = data.name)
        document.getElementById('phero-title-b').textContent = data.name
      }
      if (data && data.number) {
        document.getElementById('phero-trybot').href = `https://wa.me/${data.number}`
      } else {
        document.getElementById('phero-trybot').style.display = 'none'
      }
      if (typeof data?.uptime === 'number') {
        startUptimeTicker(data.uptime)
      }
      if (typeof data?.totalUsers === 'number') {
        document.getElementById('phero-badge-users').textContent = data.totalUsers.toLocaleString('en-US')
      }
    } catch {}
  }

  function formatUptime(seconds) {
    seconds = Math.floor(seconds)
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60

    if (d > 0) return `${d}d ${h}h ${m}m`
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  let uptimeBaseSeconds = null
  let uptimeBaseTimestamp = null
  let uptimeTickInterval = null

  function startUptimeTicker(initialSeconds) {
    uptimeBaseSeconds = initialSeconds
    uptimeBaseTimestamp = Date.now()

    if (uptimeTickInterval) clearInterval(uptimeTickInterval)
    uptimeTickInterval = setInterval(() => {
      if (uptimeBaseSeconds === null) return
      const elapsed = (Date.now() - uptimeBaseTimestamp) / 1000
      const el = document.getElementById('phero-badge-uptime')
      if (el) el.textContent = formatUptime(uptimeBaseSeconds + elapsed)
    }, 1000)
  }

  function togglePassword(inputId, iconEl) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
      input.type = 'text';
      iconEl.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
    } else {
      input.type = 'password';
      iconEl.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }
  }

  async function safeFetch(url, opts = {}) {
    opts.headers = { ...(opts.headers || {}), 'bypass-tunnel-reminder': '1' }
    const res = await fetch(url, opts)
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      const err = new Error('TUNNEL_INTERSTITIAL')
      err.isTunnelInterstitial = true
      throw err
    }
    return res
  }

  function friendlyFetchError(err) {
    if (err?.isTunnelInterstitial) {
      return 'This link needs a one-time confirmation. Open the site URL directly in a new tab, tap "Click to Continue", then come back and try again.'
    }
    return 'Connection error.'
  }

  function showAlert(panel, message, isError = true) {
    const alertEl = document.getElementById(`${panel}-alert`)
    alertEl.textContent = message
    alertEl.classList.add('show')
    if (!isError) alertEl.classList.add('success-alert')
    setTimeout(() => {
      alertEl.classList.remove('show')
      if (!isError) alertEl.classList.remove('success-alert')
    }, 3000)
  }

  function setLoading(btn, loading) {
    btn.disabled = loading
    btn.textContent = loading ? '...' : (btn.id === 'login-btn' ? 'Login' : 'Register')
  }

  let isTabAnimating = false

  function measurePanelHeight(panelEl) {
    const wasDisplay = panelEl.style.display
    const wasPosition = panelEl.style.position
    const wasVisibility = panelEl.style.visibility

    panelEl.style.position = 'absolute'
    panelEl.style.visibility = 'hidden'
    panelEl.style.display = 'block'

    const height = panelEl.scrollHeight

    panelEl.style.display = wasDisplay
    panelEl.style.position = wasPosition
    panelEl.style.visibility = wasVisibility

    return height
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isTabAnimating) return
      const tab = btn.getAttribute('data-tab')
      const isLogin = tab === 'login'
      const currentPanel = document.getElementById(isLogin ? 'register-panel' : 'login-panel')
      const targetPanel = document.getElementById(isLogin ? 'login-panel' : 'register-panel')

      if (targetPanel.classList.contains('active-panel')) return
      isTabAnimating = true

      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById('tabs-highlight').style.transform = isLogin ? 'translateX(0)' : 'translateX(100%)'
      document.getElementById('login-alert').classList.remove('show')
      document.getElementById('register-alert').classList.remove('show')

      const wrap = document.getElementById('panels-wrap')
      const currentHeight = wrap.offsetHeight
      const targetHeight = measurePanelHeight(targetPanel)

      wrap.classList.add('animating')

      gsap.killTweensOf([currentPanel, targetPanel, wrap])
      gsap.set([currentPanel, targetPanel], { clearProps: 'transform' })
      gsap.set(wrap, { height: currentHeight })
      gsap.set(currentPanel, { y: 0 })

      const tl = gsap.timeline({
        onComplete: () => {
          currentPanel.classList.remove('active-panel')
          gsap.set(currentPanel, { clearProps: 'transform' })
          gsap.set(targetPanel, { clearProps: 'transform' })
          wrap.classList.remove('animating')
          wrap.style.height = 'auto'
          isTabAnimating = false
        }
      })

      const closeState = { p: 0 }
      tl.to(closeState, {
        p: 1,
        duration: 0.55,
        ease: 'power2.in',
        onUpdate: () => {
          wrap.style.height = ((1 - closeState.p) * currentHeight) + 'px'
          gsap.set(currentPanel, { y: -currentHeight * closeState.p })
        }
      })

      tl.call(() => {
        targetPanel.classList.add('active-panel')
        gsap.set(targetPanel, { y: -targetHeight })
      })

      const openState = { p: 0 }
      tl.to(openState, {
        p: 1,
        duration: 0.35,
        ease: 'power2.out',
        onUpdate: () => {
          wrap.style.height = (openState.p * targetHeight) + 'px'
          gsap.set(targetPanel, { y: -targetHeight * (1 - openState.p) })
        }
      })
    })
  })

  async function checkNumberExists(phone) {
    try {
      const res = await safeFetch('/api/check-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      })
      const data = await res.json()
      return data.exists === true
    } catch (err) {
      console.error('Check number error:', err)
      return false
    }
  }

  let otpState = { phone: null, pendingToken: null }
  let otpResendTimer = null

  function openOtpModal(phone, pendingToken) {
    otpState = { phone, pendingToken }
    document.getElementById('otp-code').value = ''
    document.getElementById('otp-alert').classList.remove('show')
    document.getElementById('otp-modal-body').textContent =
      `We sent a 6-digit code to the WhatsApp number ending in ${phone.slice(-4)}. Enter it below.`
    document.getElementById('otp-modal').classList.add('show')
    startOtpResendCooldown()
    setTimeout(() => document.getElementById('otp-code').focus(), 150)
  }

  function closeOtpModal() {
    document.getElementById('otp-modal').classList.remove('show')
    if (otpResendTimer) { clearInterval(otpResendTimer); otpResendTimer = null }
  }

  function startOtpResendCooldown() {
    const btn = document.getElementById('otp-resend-btn')
    let seconds = 60
    btn.disabled = true
    btn.textContent = `Resend code (${seconds}s)`
    if (otpResendTimer) clearInterval(otpResendTimer)
    otpResendTimer = setInterval(() => {
      seconds--
      if (seconds <= 0) {
        clearInterval(otpResendTimer)
        otpResendTimer = null
        btn.disabled = false
        btn.textContent = 'Resend code'
      } else {
        btn.textContent = `Resend code (${seconds}s)`
      }
    }, 1000)
  }

  function showOtpAlert(message) {
    const el = document.getElementById('otp-alert')
    el.textContent = message
    el.classList.add('show')
  }

  async function submitOtp() {
    const code = document.getElementById('otp-code').value.trim()
    const btn = document.getElementById('otp-submit-btn')
    if (!code || code.length !== 6) {
      showOtpAlert('Enter the 6-digit code.')
      return
    }
    btn.disabled = true
    btn.textContent = '...'
    try {
      const res = await safeFetch('/api/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: otpState.phone, pendingToken: otpState.pendingToken, code })
      })
      const data = await res.json()
      if (data.success) {
        localStorage.setItem('token', data.token)
        localStorage.setItem('phone', otpState.phone)
        window.location.href = '/profile'
      } else {
        showOtpAlert(data.message || 'Verification failed.')
      }
    } catch (err) {
      showOtpAlert(friendlyFetchError(err))
    } finally {
      btn.disabled = false
      btn.textContent = 'Verify'
    }
  }

  async function resendOtp() {
    const btn = document.getElementById('otp-resend-btn')
    btn.disabled = true
    try {
      const res = await safeFetch('/api/resend-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: otpState.phone })
      })
      const data = await res.json()
      if (data.success) {
        otpState.pendingToken = data.pendingToken
        showOtpAlert('A new code has been sent.')
        startOtpResendCooldown()
      } else {
        showOtpAlert(data.message || 'Failed to resend code.')
        btn.disabled = false
      }
    } catch (err) {
      showOtpAlert(friendlyFetchError(err))
      btn.disabled = false
    }
  }

  document.getElementById('otp-code')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') submitOtp()
  })

  async function doLogin() {
    let phone = document.getElementById('login-phone').value.trim()
    const password = document.getElementById('login-password').value
    const btn = document.getElementById('login-btn')

    phone = phone.replace(/\D/g, '');
    
    if (!phone || !password) {
      showAlert('login', 'Please fill in all fields.')
      return
    }

    setLoading(btn, true)
    try {
      const res = await safeFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      })
      const data = await res.json()
      if (data.success) {
        openOtpModal(data.phone || phone, data.pendingToken)
      } else {
        showAlert('login', data.message || 'Login failed.')
      }
    } catch (err) {
      showAlert('login', friendlyFetchError(err))
    } finally {
      setLoading(btn, false)
    }
  }

  async function doRegister() {
    let phone = document.getElementById('register-phone').value.trim()
    const password = document.getElementById('register-password').value
    const password2 = document.getElementById('register-password2').value
    const btn = document.getElementById('register-btn')

    phone = phone.replace(/\D/g, '');

    if (!phone || !password || !password2) {
      showAlert('register', 'Please fill in all fields.')
      return
    }
    if (password !== password2) {
      showAlert('register', 'Passwords do not match.')
      return
    }
    if (password.length < 6) {
      showAlert('register', 'Password must be at least 6 characters.')
      return
    }

    setLoading(btn, true)
    try {
      const exists = await checkNumberExists(phone)
      if (!exists) {
        showModal(`Number ${phone} is not listed in the database.\n\nPlease make sure you have used the bot before registering.`)
        setLoading(btn, false)
        return
      }
    } catch (err) {
      showAlert('register', 'Cannot verify number. Please try again.')
      setLoading(btn, false)
      return
    }

    try {
      const res = await safeFetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      })
      const data = await res.json()
      if (data.success) {
        openOtpModal(data.phone || phone, data.pendingToken)
      } else {
        showAlert('register', data.message || 'Registration failed.')
      }
    } catch (err) {
      showAlert('register', friendlyFetchError(err))
    } finally {
      setLoading(btn, false)
    }
  }

  document.getElementById('login-password')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') doLogin()
  })
  document.getElementById('register-password2')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') doRegister()
  })
