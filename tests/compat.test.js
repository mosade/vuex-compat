// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { makeStore } from '../example/store.js'
import { useUserStore, useProfileStore } from '../example/stores/index.js'
import { mapState, mapGetters, mapMutations, mapActions, createNamespacedHelpers, useStore } from '../src/vuex-compat/index.js'

let store, pinia
beforeEach(() => {
  ;({ store, pinia } = makeStore())
  setActivePinia(pinia)
})

describe('state', () => {
  it('reads root / module / nested module state', () => {
    expect(store.state.appName).toBe('demo')
    expect(store.state.user.name).toBe('Tom')
    expect(store.state.account.id).toBe(42)
    expect(store.state.account.profile.age).toBe(18)
    expect(store.state.counter.count).toBe(0)
  })
  it('leaf module state is the Pinia $state (same reactive object)', () => {
    expect(store.state.user).toBe(useUserStore().$state)
  })
  it('stays in sync with direct Pinia usage', () => {
    useUserStore().name = 'Jerry'
    expect(store.state.user.name).toBe('Jerry')
    store.state.account.profile.age = 30
    expect(useProfileStore().age).toBe(30)
  })
  it('enumerates keys', () => {
    expect(Object.keys(store.state)).toEqual(expect.arrayContaining(['appName', 'loading', 'user', 'account', 'counter']))
    expect(JSON.parse(JSON.stringify(store.state.account))).toEqual({ id: 42, profile: { age: 18 } })
  })
})

describe('getters', () => {
  it('reads namespaced / root / non-namespaced getters', () => {
    expect(store.getters['user/fullName']).toBe('Tom Smith')
    expect(store.getters['user/byId'](2).n).toBe('b')
    expect(store.getters['account/profile/isAdult']).toBe(true)
    expect(store.getters.title).toBe('[demo]')
    expect(store.getters.double).toBe(0)
  })
})

describe('commit / dispatch', () => {
  it('commit calls actions, mapping table and function mappings', () => {
    store.commit('user/setName', 'A')
    expect(store.state.user.name).toBe('A')
    store.commit('user/SET_TOKEN', 't1')
    expect(store.state.user.token).toBe('t1')
    store.commit({ type: 'user/SET_NAME' })
    store.commit('user/SET_NAME', 'B')
    expect(store.state.user.name).toBe('B')
    store.commit('account/profile/setAge', 10)
    expect(store.getters['account/profile/isAdult']).toBe(false)
  })
  it('non-namespaced and root', () => {
    store.commit('increment', 3)
    expect(store.state.counter.count).toBe(3)
    store.commit('setLoading', true)
    expect(store.state.loading).toBe(true)
  })
  it('dispatch returns promise with result, action mapping works', async () => {
    await expect(store.dispatch('user/login', { token: 'x' })).resolves.toBe('ok')
    await store.dispatch('user/setToken', { token: 'y' })
    expect(store.state.user.token).toBe('y')
  })
  it('destructured commit works', () => {
    const { commit } = store
    commit('user/setName', 'D')
    expect(store.state.user.name).toBe('D')
  })
  it('unknown type logs error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.commit('user/nope')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('subscribe / watch / replaceState', () => {
  it('subscribe & subscribeAction', async () => {
    const muts = []
    const acts = []
    store.subscribe((m) => muts.push(m.type))
    store.subscribeAction({ before: (a) => acts.push('b:' + a.type), after: (a) => acts.push('a:' + a.type) })
    store.commit('user/setName', 'x')
    await store.dispatch('user/login', { token: 'z' })
    expect(muts).toEqual(['user/setName'])
    expect(acts).toEqual(['b:user/login', 'a:user/login'])
  })
  it('watch', async () => {
    const cb = vi.fn()
    store.watch((state, getters) => getters['user/fullName'], cb)
    store.commit('user/setName', 'W')
    await nextTick()
    expect(cb).toHaveBeenCalledWith('W Smith', 'Tom Smith', expect.anything())
  })
  it('replaceState', () => {
    store.replaceState({ appName: 'new', user: { name: 'R' }, account: { id: 1, profile: { age: 5 } } })
    expect(store.state.appName).toBe('new')
    expect(store.state.user.name).toBe('R')
    expect(store.state.account.id).toBe(1)
    expect(store.state.account.profile.age).toBe(5)
  })
})

describe('component usage', () => {
  it('this.$store, map helpers, reactivity in template', async () => {
    const { mapState: mapUserState, mapActions: mapUserActions } = createNamespacedHelpers('user')
    const Comp = defineComponent({
      computed: {
        ...mapState(['appName']),
        ...mapState('user', { uname: 'name', upper: (s) => s.name.toUpperCase() }),
        ...mapState({ age: (s) => s.account.profile.age }),
        ...mapGetters('user', ['fullName']),
        ...mapGetters({ dbl: 'double' }),
        ...mapUserState({ token: 'token' }),
      },
      methods: {
        ...mapMutations('user', ['setName']),
        ...mapMutations({ inc: 'increment' }),
        ...mapActions('user', ['login']),
        ...mapUserActions({ login2: 'login' }),
      },
      render() {
        return h('div', `${this.appName}|${this.uname}|${this.upper}|${this.fullName}|${this.dbl}|${this.age}|${this.token}|${this.$store.state.user.name}`)
      },
    })
    const w = mount(Comp, { global: { plugins: [pinia, store] } })
    expect(w.text()).toBe('demo|Tom|TOM|Tom Smith|0|18||Tom')
    w.vm.setName('Ann')
    w.vm.inc(2)
    await w.vm.login({ token: 'k' })
    await nextTick()
    expect(w.text()).toBe('demo|Ann|ANN|Ann Smith|4|18|k|Ann')
    await w.vm.login2({ token: 'k2' })
    await nextTick()
    expect(w.vm.token).toBe('k2')
  })
  it('useStore() in setup', () => {
    let s
    const Comp = defineComponent({ setup() { s = useStore(); return () => h('div') } })
    mount(Comp, { global: { plugins: [pinia, store] } })
    expect(s).toBe(store)
  })
})
