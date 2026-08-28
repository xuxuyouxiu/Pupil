// 诊断：主进程 app.getLocale 与渲染进程 navigator.language 是否一致
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false })
  w.loadURL('data:text/html,<html></html>').then(() => {
    w.webContents.executeJavaScript('navigator.language').then((nav) => {
      console.log('app.getLocale =', app.getLocale())
      console.log('app.getPreferredLocales =', app.getPreferredLocales().join(','))
      console.log('navigator.language =', nav)
      app.quit()
    })
  })
})
