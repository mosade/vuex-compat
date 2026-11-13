// @vitest-environment happy-dom
// 这些用例用来锁定"和 Vuex 行为不同 / 不支持"的场景，确保 README 的说明和实际行为一致
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, watch, isReactive, defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, defineStore } from 'pinia'
import { makeStore } from '../example/store.js'
import { useUserStore, useAccountStore } from '../example/stores/index.js'
import { mapMutations, createStore } from '../src/vuex-compat/index.js'
import * as compat from '../src/vuex-compat/index.js'

let store, pinia
beforeEach(() => {
  ;({ store, pinia } = makeStore())
  setActivePinia(pinia)
})
const silence = (m = 'warn') => vi.spyOn(console, m).mockImplementation(() => {})

describe('subscribe 只能捕获经过兼容层发起的调用', () => {
  it('直接调用 Pinia action 或直接改 state 都不会触发 subscribe', () => {
    const fn = vi.fn()
    store.subscribe(fn)
    useUserStore().setName('x')
    useUserStore().name = 'y'
    store.state.user.name = 'z'
    expect(fn).not.toHaveBeenCalled()
  })
  it('直接调用 Pinia action 不会触发 subscribeAction', () => {
    const fn = vi.fn()
    store.subscribeAction(fn)
    useUserStore().login({ token: 1 })
    expect(fn).not.toHaveBeenCalled()
  })
  it('commit 映射到异步 action 时，subscribe 在 action 执行完之前就被调用', () => {
    const states = []
    store.subscribe((m, state) => states.push(state.user.token))
    store.commit('user/login', { token: 'later' }) // 不该这么用，仅用来说明行为
    expect(states).toEqual([''])
  })
})

describe('mutation 和 action 重名', () => {
  it('不配置映射时，commit 和 dispatch 调用的是同一个 Pinia action', async () => {
    const spy = vi.spyOn(useUserStore(), 'login')
    store.commit('user/login', { token: 'a' })
    await store.dispatch('user/login', { token: 'b' })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('state', () => {
  it('有子模块的节点和根 state 是普通 Proxy，不是 reactive 对象', () => {
    expect(isReactive(store.state)).toBe(false)
    expect(isReactive(store.state.account)).toBe(false)
    expect(store.state.account).not.toBe(useAccountStore().$state)
    expect(isReactive(store.state.user)).toBe(true) // 叶子模块正常
  })
  it('watch 不能直接把非叶子节点作为 source，用函数形式 + deep 可以', async () => {
    const w = silence()
    const bad = vi.fn()
    watch(store.state.account, bad)
    expect(w).toHaveBeenCalled()
    const good = vi.fn()
    watch(() => store.state.account, good, { deep: true })
    store.state.account.profile.age = 99
    await nextTick()
    expect(bad).not.toHaveBeenCalled()
    expect(good).toHaveBeenCalled()
  })
  it('不能整体替换模块 state（store.state.user = {...} 会被忽略）', () => {
    const w = silence()
    store.state.user = { name: 'new' }
    expect(store.state.user.name).toBe('Tom')
    expect(w).toHaveBeenCalled()
  })
  it('没有配置 root store 时，根级 state 的写入会被忽略', () => {
    const { store: s } = makeStoreWithoutRoot()
    const w = silence()
    s.state.foo = 1
    expect(s.state.foo).toBeUndefined()
    expect(w).toHaveBeenCalled()
  })
  it('模块路径和 root state 的 key 重名时，模块优先', () => {
    const useR = defineStore('r-clash', { state: () => ({ user: 'root-value' }) })
    const s = compat.createCompatStore({ pinia, root: useR, modules: { user: useUserStore } })
    expect(s.state.user.name).toBe('Tom')
  })
  it('strict 模式不支持：在 commit 外修改 state 不会报错', () => {
    store.state.user.name = 'direct'
    expect(store.state.user.name).toBe('direct')
  })
})

describe('getters', () => {
  it('不能枚举（Object.keys / for-in / 展开都是空的）', () => {
    expect(Object.keys(store.getters)).toEqual([])
    expect({ ...store.getters }).toEqual({})
  })
  it('查找规则比 Vuex 宽松：用 getters 读 state 字段或 action 也有返回值', () => {
    expect(store.getters['user/name']).toBe('Tom')
    expect(typeof store.getters['user/setName']).toBe('function')
  })
  it('多个非命名空间 store 有同名 getter 时返回第一个（Vuex 会报 duplicate getter）', () => {
    const useA = defineStore('dupA', { getters: { same: () => 'A' } })
    const useB = defineStore('dupB', { getters: { same: () => 'B' } })
    const s = compat.createCompatStore({ pinia, modules: { a: { useStore: useA, namespaced: false }, b: { useStore: useB, namespaced: false } } })
    expect(s.getters.same).toBe('A')
  })
})

describe('模块', () => {
  it('不支持"命名空间父模块下的非命名空间子模块"继承父命名空间', () => {
    const useChild = defineStore('child', { getters: { g: () => 1 }, actions: { act() {} } })
    const s = compat.createCompatStore({ pinia, modules: { parent: useAccountStore, 'parent/child': { useStore: useChild, namespaced: false } } })
    silence()
    // Vuex 中应为 getters['parent/g']，这里变成了全局的 g
    expect(s.getters['parent/g']).toBeUndefined()
    expect(s.getters.g).toBe(1)
  })
  it('registerModule 只接受 Pinia useStore，不接受 Vuex 模块对象', () => {
    expect(() => store.registerModule('legacy', { namespaced: true, state: () => ({}) })).toThrow()
  })
  it('unregisterModule 不会清掉 Pinia 里的状态，重新注册后还是旧值', () => {
    store.commit('user/setName', 'kept')
    store.unregisterModule('user')
    expect(store.state.user).toBeUndefined()
    store.registerModule('user', useUserStore)
    expect(store.state.user.name).toBe('kept')
  })
})

describe('replaceState 是合并而不是整体替换', () => {
  it('没有传入的字段会保留，嵌套对象会深合并', () => {
    store.replaceState({ user: { name: 'R' } })
    expect(store.state.user.name).toBe('R')
    expect(store.state.user.list.length).toBe(2)
    expect(store.state.appName).toBe('demo')
  })
})

describe('其他不支持的 API', () => {
  it('createStore / new Store 不可用', () => {
    expect(() => createStore({})).toThrow()
    expect(compat.Store).toBeUndefined()
  })
  it('Vuex 内部属性不存在', () => {
    expect(store._vm).toBeUndefined()
    expect(store._mutations).toBeUndefined()
    expect(store._actions).toBeUndefined()
    expect(store._modulesNamespaceMap).toBeUndefined()
  })
  it('hotUpdate 是空操作', () => {
    const w = silence()
    store.hotUpdate({})
    expect(w).toHaveBeenCalled()
  })
})

describe('已支持（避免误解）', () => {
  it('命名空间 mapMutations 函数形式里 commit(..., { root: true })', () => {
    const Comp = defineComponent({
      methods: { ...mapMutations('user', { go(commit) { commit('increment', 5, { root: true }); commit('setName', 'L') } }) },
      render: () => h('div'),
    })
    const w = mount(Comp, { global: { plugins: [pinia, store] } })
    w.vm.go()
    expect(store.state.counter.count).toBe(5)
    expect(store.state.user.name).toBe('L')
  })
})

function makeStoreWithoutRoot() {
  return { store: compat.createCompatStore({ pinia, modules: { user: useUserStore } }) }
}

describe('Vue 内部标记不外泄', () => {
  it('toRaw(store.state) 不会返回 root store 的原始 state', async () => {
    const { toRaw, reactive } = await import('vue')
    expect(toRaw(store.state)).toBe(store.state)
    // 被 reactive() 包一层后读写仍然走兼容层
    const wrapped = reactive({ s: store.state })
    wrapped.s.account.profile.age = 7
    expect(store.state.account.profile.age).toBe(7)
  })
})
