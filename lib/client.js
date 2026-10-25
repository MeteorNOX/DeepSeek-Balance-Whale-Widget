window.__ModuleLoader__.load({
  id: 'dsh-whale-widget',
  factory: () => {
    function apply(ctx) {
      const mount = { active: true }
      let script
      function stopOwnedWidget() {
        const lifecycle = window.__dshWhaleLifecycle
        if (lifecycle && lifecycle.owner === mount) lifecycle.stop('client-disabled')
      }
      // Register cleanup before starting the request: disable may race script loading.
      ctx.effect(() => () => {
        mount.active = false
        stopOwnedWidget()
        if (script) script.remove()
      }, 'dsh-whale-widget: client lifecycle')
      script = document.createElement('script')
      script.src = '/dsh-whale/widget.js'
      script.async = true
      script.dataset.dshWhaleWidget = '1'
      script.__dshWhaleMount = mount
      script.onload = () => { if (!mount.active) stopOwnedWidget() }
      script.onerror = () => script.remove()
      const parent = document.body || document.head || document.documentElement
      if (parent && mount.active) parent.appendChild(script)
    }
    return { apply, inject: [] }
  }
})
