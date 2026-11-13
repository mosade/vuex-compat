import { createPinia } from 'pinia'
import { createCompatStore } from '../src/vuex-compat/index.js'
import { useRootStore, useUserStore, useProfileStore, useAccountStore, useCounterStore } from './stores/index.js'

export function makeStore(pinia = createPinia()) {
  const store = createCompatStore({
    pinia,
    root: useRootStore,
    modules: {
      user: {
        useStore: useUserStore,
        // 原 Vuex 中 mutation SET_TOKEN 与 action setToken 同名/不同名的情况
        mutations: { SET_TOKEN: 'setTokenSync', SET_NAME: (s, name) => { s.name = name } },
        actions: { setToken: 'login' },
      },
      account: useAccountStore,
      'account/profile': useProfileStore,
      counter: { useStore: useCounterStore, namespaced: false },
    },
  })
  return { pinia, store }
}
