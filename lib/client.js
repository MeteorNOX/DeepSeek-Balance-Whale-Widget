// dsh-whale-widget — client 半（浏览器端模块）。
//
// 职责：在官方插件页注册「精选插件」入口 tab（dsh-featured 生态的轻量入口）：
//   · 完整版 dsh-featured 未安装时，展示欢迎页与一键安装按钮，装完由完整版接管；
//   · 完整版已加载时自动让位（window.__DSH_FEATURED_FULL__ 判定），任何激活顺序都不会双 tab；
//   · 与挂件本体（lib/index.js + assets/whale-widget.js）完全互不依赖，本文件出错也不影响挂件。
//
// 集成约定出处：https://github.com/skillpie/dsh-plugins/blob/main/dsh-featured/AI-INTEGRATION.md
// 边界：入口 ≠ 上榜 —— 是否出现在精选列表由 skillpie.cn 收录流程决定，本文件不做任何收录判定。
//
// 实现说明：本段是 dsh-plugins-plugin embed/featured.client.js 的内联欢迎页逻辑，
// 按约定以内联代码随本插件分发（不依赖跨包 require；带 hooks 的组件一律经
// slots.register 交给框架渲染，绝不作为普通函数直接调用）。
window.__ModuleLoader__.load({
  id: 'dsh-whale-widget',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-plugins-plugin' // 与完整版/其他内联版共用的 slot id：全屏永远只有一块
    const FULL_PKG = 'dsh-featured'

    const zh = {
      tabLabel: '精选插件',
      welcome: '精选插件完整版（dsh-featured）未安装。',
      installFull: '安装完整版',
      installing: '正在安装完整版…',
      installed: '已安装，刷新后即可使用完整功能。',
      installedShort: '已安装',
      desc: '一个入口逛完社区精选的好插件：搜索、标签筛选、一键安装、README 详情。',
    }
    const en = {
      tabLabel: 'Featured',
      welcome: 'The full Featured plugin (dsh-featured) is not installed.',
      installFull: 'Install full version',
      installing: 'Installing…',
      installed: 'Installed — refresh to use the full experience.',
      installedShort: 'Installed',
      desc: 'One tab for community-featured plugins: search, filter, one-click install, README details.',
    }

    const S = {
      wrap: { padding: '24px 16px', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 },
      desc: { fontSize: 13, lineHeight: 1.7, margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      note: { fontSize: 13, lineHeight: 1.7, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      btn: {
        alignSelf: 'flex-start', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 500,
        padding: '7px 16px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-brand-primary)', color: '#fff',
      },
      btnOff: { opacity: 0.6, cursor: 'default' },
    }

    function FeaturedSection(props) {
      const install = props.install
      const t = props.t || ((k) => zh[k])
      // 已安装判定：宿主路由返回的 installed 表里有 FULL_PKG
      const pair = React.useState('idle') // idle | running | installed
      const st = pair[0], setSt = pair[1]

      React.useEffect(() => {
        if (st !== 'idle') return
        if (typeof install !== 'function') { setSt('installed'); return }
        setSt('running')
        try {
          install({ spec: FULL_PKG, title: t('tabLabel'), version: '' })
          setSt('installed')
        } catch {
          setSt('installed')
        }
      }, [st, install])

      const label = st === 'running' ? t('installing')
        : (st === 'installed' ? t('installedShort') : t('installFull'))

      return h('div', { style: S.wrap },
        h('p', { style: S.desc }, t('desc')),
        st === 'idle' ? h('p', { style: S.note }, t('welcome')) : null,
        h('button', {
          type: 'button',
          style: Object.assign({}, S.btn, st === 'installed' ? S.btnOff : {}),
          disabled: st === 'installed',
          onClick: () => {
            if (st !== 'idle' || typeof install !== 'function') return
            setSt('running')
            try { install({ spec: FULL_PKG, title: t('tabLabel'), version: '' }); setSt('installed') }
            catch { setSt('installed') }
          },
        }, label))
    }

    function initFeatured(ctx) {
      if (typeof window !== 'undefined') window.__FEATURED_INIT_CALLED__ = true
      if (typeof window !== 'undefined' && window.__DSH_FEATURED_APPLIED__) return
      if (typeof window !== 'undefined') window.__DSH_FEATURED_APPLIED__ = true
      if (typeof window !== 'undefined' && window.__DSH_FEATURED_FULL__) {
        // 全量版（dsh-featured 插件）已加载：让位，不注册内联板块，避免双 tab 竞态
        return
      }
      try {
        const localeDisposable = ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-whale-widget: featured locale')
        const t = ctx.locale.bind(NS)
        let tabDisposable = null
        ctx.slots.inject('plugins.tab', () => {
          tabDisposable = ctx.slots.register({
            name: 'plugins.tab',
            id: 'dsh-plugins-plugin',
            label: () => t('tabLabel'),
            locale: NS,
            priority: 100,
          }, FeaturedSection)
          return tabDisposable
        }, 'dsh-whale-widget: featured tab')

        if (typeof window !== 'undefined') {
          // 完整版 dsh-featured 加载后可凭本句柄主动注销内联入口（disposeInlineLater）
          window.__DSH_FEATURED_ENTRY__ = {
            kind: 'inline',
            dispose() {
              try { if (typeof tabDisposable === 'function') tabDisposable() } catch { /* 已注销 */ }
              try { if (typeof localeDisposable === 'function') localeDisposable() } catch { /* 已注销 */ }
              window.__DSH_FEATURED_APPLIED__ = false
              window.__DSH_FEATURED_ENTRY__ = null
            },
          }
          window.__FEATURED_OK__ = true
        }
      } catch (e) {
        if (typeof window !== 'undefined') window.__FEATURED_ERR__ = String(e && (e.stack || e.message || e))
      }
    }

    function apply(ctx) {
      initFeatured(ctx)
    }

    // 诊断标记：完整版/排障脚本可据此判断内联入口是否已挂载
    if (typeof window !== 'undefined') {
      window.__FEATURED_FACTORY_RAN__ = true
      window.__DSH_FEATURED_INIT__ = initFeatured
    }

    return { name: 'dsh-whale-widget', inject: ['slots', 'locale'], apply }
  },
})
