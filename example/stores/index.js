import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// 原 Vuex 根模块
export const useRootStore = defineStore('root', {
  state: () => ({ appName: 'demo', loading: false }),
  getters: { title: (s) => `[${s.appName}]` },
  actions: {
    setLoading(v) { this.loading = v },
  },
})

// 原 Vuex 命名空间模块 user（mutation 改写成 action）
export const useUserStore = defineStore('user', {
  state: () => ({ name: 'Tom', token: '', list: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }] }),
  getters: {
    fullName: (s) => `${s.name} Smith`,
    byId: (s) => (id) => s.list.find((i) => i.id === id),
  },
  actions: {
    setName(name) { this.name = name },
    setTokenSync(t) { this.token = t },
    async login({ token }) {
      await Promise.resolve()
      this.setTokenSync(token)
      return 'ok'
    },
  },
})

// 嵌套模块 account/profile（setup 风格）
export const useProfileStore = defineStore('account/profile', () => {
  const age = ref(18)
  const isAdult = computed(() => age.value >= 18)
  function setAge(v) { age.value = v }
  return { age, isAdult, setAge }
})

// account 自身
export const useAccountStore = defineStore('account', {
  state: () => ({ id: 42 }),
  actions: { setId(id) { this.id = id } },
})

// 原 Vuex 非命名空间模块
export const useCounterStore = defineStore('counter', {
  state: () => ({ count: 0 }),
  getters: { double: (s) => s.count * 2 },
  actions: { increment(n = 1) { this.count += n } },
})
