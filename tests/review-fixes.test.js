// @vitest-environment happy-dom
// 代码审查发现的问题的回归测试
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, nextTick, defineComponent, h, isShallow } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, defineStore } from 'pinia'
import { makeStore } from '../example/store.js'
import { mapGetters, mapState } from '../src/vuex-compat/index.js'

let store, pinia
beforeEach(() => {
  ;({ store, pinia } = makeStore())
  setActivePinia(pinia)
})
afterEach(() => vi.restoreAllMocks())

const useCartStore = defineStore('cart', {
  state: () => ({ items: [1, 2] }),
  getters: { total: (s) => s.items.length },
})

describe('registerModule / unregisterModule 触发响应式更新', () => {
  it('computed 在模块注册前读取，注册后自动更新；注销后变回 undefined', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = computed(() => store.state.cart && store.state.cart.items.length)
    const total = computed(() => store.getters['cart/total'])
    const has = computed(() => store.hasModule('cart'))
    expect([items.value, total.value, has.value]).toEqual([undefined, undefined, false])

    store.registerModule('cart', useCartStore)
    expect([items.value, total.value, has.value]).toEqual([2, 2, true])

    store.unregisterModule('cart')
    expect([items.value, total.value, has.value]).toEqual([undefined, undefined, false])
  })

  it('组件里的 mapState / mapGetters 在懒注册后重新渲染', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Comp = defineComponent({
      computed: { ...mapState('cart', ['items']), ...mapGetters('cart', ['total']) },
      render() {
        return h('div', `${this.items ? this.items.length : '-'}|${this.total ?? '-'}|${this.$store.state.cart ? 'y' : 'n'}`)
      },
    })
    const w = mount(Comp, { global: { plugins: [pinia, store] } })
    expect(w.text()).toBe('-|-|n')
    store.registerModule('cart', useCartStore)
    await nextTick()
    expect(w.text()).toBe('2|2|y')
  })

  it('注册嵌套模块后，父节点的 state 也会更新', () => {
    const keys = computed(() => Object.keys(store.state.account))
    expect(keys.value).not.toContain('extra')
    store.registerModule(['account', 'extra'], defineStore('acc-extra', { state: () => ({ v: 1 }) }))
    expect(keys.value).toContain('extra')
    expect(store.state.account.extra.v).toBe(1)
  })
})

describe('unregisterModule 连同子模块一起注销', () => {
  it('注销 account 时 account/profile 也被移除', () => {
    store.unregisterModule('account')
    expect(store.hasModule('account')).toBe(false)
    expect(store.hasModule('account/profile')).toBe(false)
    expect(store.state.account).toBeUndefined()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.commit('account/profile/setAge', 1)
    expect(err).toHaveBeenCalled()
  })
  it('注销不存在的模块会给出警告', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.unregisterModule('nope')
    expect(w).toHaveBeenCalled()
  })
})

describe('Object.prototype 上的成员不会被当成映射或 action', () => {
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])('commit / dispatch user/%s 报 unknown，且不触发订阅', (name) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sub = vi.fn()
    store.subscribe(sub)
    store.commit(`user/${name}`)
    expect(store.dispatch(name)).toBeUndefined()
    expect(err).toHaveBeenCalledTimes(2)
    expect(sub).not.toHaveBeenCalled()
  })
  it('getters 中也不会把原型成员当作 getter', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(store.getters['user/constructor']).toBeUndefined()
    expect('user/toString' in store.getters).toBe(false)
  })
  it('真正名为 toString 的 Pinia action 仍然可以调用', () => {
    const useOdd = defineStore('odd', { state: () => ({ n: 0 }), actions: { toString() { this.n++ } } })
    store.registerModule('odd', useOdd)
    store.commit('odd/toString')
    expect(store.state.odd.n).toBe(1)
  })
})

describe('getters 的 Proxy 不会对 Vue 内部标记报警告', () => {
  it('isShallow / 放进 reactive 都不产生 unknown getter 警告', async () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { reactive, isReactive, isReadonly } = await import('vue')
    isShallow(store.getters)
    isReactive(store.getters)
    isReadonly(store.getters)
    reactive({ g: store.getters }).g
    expect(w).not.toHaveBeenCalled()
  })
})

describe('replaceState 遇到非对象的模块 state', () => {
  it('跳过并给出警告', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.replaceState({ user: null, appName: 'x' })
    expect(store.state.user.name).toBe('Tom')
    expect(store.state.appName).toBe('x')
    expect(w).toHaveBeenCalledWith(expect.stringContaining('"user" must be an object, got null'))
  })
})

describe('模块上下文缓存', () => {
  it('同一命名空间复用上下文，注册表变化后失效', () => {
    const a = store._getModuleContext('user', 't')
    expect(store._getModuleContext('user', 't')).toBe(a)
    store.registerModule('cart', useCartStore)
    expect(store._getModuleContext('user', 't')).not.toBe(a)
  })
  it('上下文里的 state 始终是最新的', () => {
    const ctx = store._getModuleContext('account', 't')
    store.registerModule('account/extra', defineStore('acc-extra2', { state: () => ({ v: 2 }) }))
    expect(store._getModuleContext('account', 't').state.extra.v).toBe(2)
    expect(ctx).not.toBe(store._getModuleContext('account', 't'))
  })
})

describe('生产环境不打印警告', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  it('NODE_ENV=production 时 warn 被关闭，unknown type 的 error 仍然打印', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.resetModules()
    const { createCompatStore } = await import('../src/vuex-compat/index.js')
    const { createPinia } = await import('pinia')
    const s = createCompatStore({ pinia: createPinia(), modules: {} })
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = vi.spyOn(console, 'error').mockImplementation(() => {})
    s.getters['nope/x']
    s.unregisterModule('nope')
    s.commit('nope/x')
    expect(w).not.toHaveBeenCalled()
    expect(e).toHaveBeenCalledTimes(1)
  })
})
