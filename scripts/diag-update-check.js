// 诊断 harness：用与 Pupil 完全相同的 Electron net.fetch 复现更新检查网络路径
const { app, net } = require('electron')

app.whenReady().then(async () => {
  const targets = [
    ['GitHub API', 'https://api.github.com/repos/xuxuyouxiu/Pupil/releases/latest'],
    ['CDN latest.yml', 'https://dl.xuxuya66.top/download/pupil/latest.yml']
  ]
  for (const [name, url] of targets) {
    // 与 updater.check 完全一致的调用方式（含 AbortSignal）
    try {
      const res = await net.fetch(url, {
        headers: { 'user-agent': 'pupil-updater', accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000)
      })
      const text = await res.text()
      console.log(`[${name}] HTTP ${res.status} | ${text.slice(0, 150).replace(/\s+/g, ' ')}`)
    } catch (e) {
      console.log(`[${name}] FETCH-ERROR: ${e.message}${e.cause ? ' | cause: ' + (e.cause.message || e.cause) : ''}`)
    }
  }
  app.quit()
})
