
  function openAuth() {
    document.getElementById('auth-overlay').classList.add('show')
  }
  function closeAuth(e) {
    if (e && e.target !== e.currentTarget) return
    const overlay = document.getElementById('auth-overlay')
    overlay.classList.add('closing')
    setTimeout(() => {
      overlay.classList.remove('show')
      overlay.classList.remove('closing')
    }, 220)
  }

  async function handleAccountClick() {
    const token = localStorage.getItem('token')
    try {
      const res = await safeFetch('/api/profile', {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {}
      })
      const data = await res.json()
      if (data.success) {
        window.location.href = '/profile'
        return
      }
    } catch (_) { }
    openAuth()
  }
