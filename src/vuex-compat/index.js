/**
 * vuex-compat —— 以 Pinia 为底层、模拟 Vuex 4 API 的兼容层
 *
 * 目标：业务模块逐个改写为 Pinia store，旧代码中的
 *   this.$store.state.user.name / store.getters['user/fullName']
 *   store.commit('user/setName', x) / store.dispatch('user/fetch')
 *   mapState / mapGetters / mapMutations / mapActions / createNamespacedHelpers
 *   useStore()
 * 无需修改即可继续工作；新代码直接使用 Pinia。
 *
 * 映射规则：
 *   - 命名空间 'a/b'          → 注册在 modules['a/b'] 的 Pinia store
 *   - state.a.b.x             → useAbStore().$state.x
 *   - getters['a/b/x']        → useAbStore().x
 *   - commit / dispatch('a/b/x', payload) → useAbStore().x(payload)
 *     （Pinia 没有 mutation，mutation 改写为 action；也可用 mutations / actions 映射表重定向）
 */
import { inject, watch as vueWatch } from 'vue'

export const storeKey = 'store'

let activeStore = null
const isDev = typeof process !== 'undefined' ? process.env.NODE_ENV !== 'production' : true
const PREFIX = '[vuex-compat]'

function warn(msg) {
  if (isDev) console.warn(`${PREFIX} ${msg}`)
}

function isObject(v) {
  return v !== null && typeof v === 'object'
}

function normalizePath(path) {
  return Array.isArray(path) ? path.join('/') : String(path).replace(/^\/+|\/+$/g, '')
}

function splitType(type) {
  const i = type.lastIndexOf('/')
  return i === -1 ? ['', type] : [type.slice(0, i), type.slice(i + 1)]
}

function unifyObjectStyle(type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }
  if (typeof type !== 'string') throw new Error(`${PREFIX} expects string as the type, but found ${typeof type}.`)
  return { type, payload, options }
}

/**
 * 模块配置可以是：
 *   useUserStore
 *   {
 *     useStore: useUserStore,
 *     namespaced: true,          // false 时 getters/commit/dispatch 不加前缀（模拟 Vuex 非命名空间模块）
 *     mutations: { SET_NAME: 'setName', RESET: (store) => store.$reset() },
 *     actions:   { fetchUser: 'loadUser' },
 *   }
 */
function normalizeModule(path, def) {
  const conf = typeof def === 'function' ? { useStore: def } : { ...def }
  if (typeof conf.useStore !== 'function') {
    throw new Error(`${PREFIX} module "${path}" must provide a Pinia useStore function.`)
  }
  return {
    path,
    useStore: conf.useStore,
    namespaced: conf.namespaced !== false,
    mutations: conf.mutations || {},
    actions: conf.actions || {},
  }
}

export class CompatStore {
  /**
   * @param {object} options
   * @param {import('pinia').Pinia} options.pinia  Pinia 实例（必须，保证在组件外 import store 也能用）
   * @param {Function|object} [options.root]       对应 Vuex 根 state/getters/mutations/actions 的 Pinia store
   * @param {Record<string, Function|object>} [options.modules]  key 为命名空间路径，如 'user'、'account/profile'
   * @param {Function[]} [options.plugins]         Vuex 风格插件 (store) => void
   */
  constructor({ pinia, root, modules = {}, plugins = [] } = {}) {
    if (!pinia) throw new Error(`${PREFIX} options.pinia is required.`)
    this._pinia = pinia
    this._root = root ? normalizeModule('', root) : null
    this._modules = new Map()
    this._subscribers = []
    this._actionSubscribers = []
    this._nodeCache = new Map()
    this._localGettersCache = new Map()

    Object.keys(modules).forEach((p) => {
      const path = normalizePath(p)
      this._modules.set(path, normalizeModule(path, modules[p]))
    })

    // 与 Vuex 一致：commit / dispatch 绑定 this，支持解构使用
    const store = this
    this.commit = function boundCommit(type, payload, options) {
      return CompatStore.prototype.commit.call(store, type, payload, options)
    }
    this.dispatch = function boundDispatch(type, payload) {
      return CompatStore.prototype.dispatch.call(store, type, payload)
    }

    this._getters = this._createGettersProxy()

    plugins.forEach((plugin) => plugin(this))
    if (!activeStore) activeStore = this
  }

  // ---------- 安装 ----------

  install(app, injectKey) {
    app.provide(injectKey || storeKey, this)
    app.config.globalProperties.$store = this
    activeStore = this
  }

  // ---------- 内部工具 ----------

  _instance(mod) {
    return mod.useStore(this._pinia)
  }

  _hasModuleOrDescendant(path) {
    if (this._modules.has(path)) return true
    const prefix = `${path}/`
    for (const key of this._modules.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  _childSegments(path) {
    const prefix = path ? `${path}/` : ''
    const set = new Set()
    for (const key of this._modules.keys()) {
      if (prefix && !key.startsWith(prefix)) continue
      set.add(key.slice(prefix.length).split('/')[0])
    }
    return [...set]
  }

  /** 某路径自身的 state（Pinia $state），根路径为 root store 的 state */
  _ownState(path) {
    const mod = path ? this._modules.get(path) : this._root
    return mod ? this._instance(mod).$state : undefined
  }

  /** state 树上的节点：叶子模块直接返回 Pinia 的响应式 $state，否则返回合并子模块的代理 */
  _stateAt(path) {
    if (path && this._modules.has(path) && this._childSegments(path).length === 0) {
      return this._ownState(path)
    }
    if (path && !this._hasModuleOrDescendant(path)) return undefined
    let node = this._nodeCache.get(path)
    if (!node) {
      node = this._createStateNode(path)
      this._nodeCache.set(path, node)
    }
    return node
  }

  _createStateNode(path) {
    const store = this
    const childPath = (key) => (path ? `${path}/${key}` : key)
    return new Proxy(Object.create(null), {
      get(_, key) {
        // 不能把 Vue 内部标记转发给 Pinia state，否则 isReactive/toRaw 会拿到不含子模块的原始对象
        if (typeof key === 'string' && key.startsWith('__v_')) return undefined
        if (typeof key === 'string' && store._hasModuleOrDescendant(childPath(key))) {
          return store._stateAt(childPath(key))
        }
        const own = store._ownState(path)
        return own ? own[key] : undefined
      },
      set(_, key, value) {
        if (typeof key === 'string' && store._hasModuleOrDescendant(childPath(key))) {
          warn(`cannot replace module state "${childPath(key)}" directly, use replaceState().`)
          return true
        }
        const own = store._ownState(path)
        if (!own) {
          warn(`no store registered at "${path || '<root>'}", set "${String(key)}" ignored.`)
          return true
        }
        own[key] = value
        return true
      },
      has(_, key) {
        if (typeof key === 'string' && store._hasModuleOrDescendant(childPath(key))) return true
        const own = store._ownState(path)
        return own ? key in own : false
      },
      ownKeys() {
        const own = store._ownState(path)
        const keys = new Set(own ? Reflect.ownKeys(own) : [])
        store._childSegments(path).forEach((k) => keys.add(k))
        return [...keys]
      },
      getOwnPropertyDescriptor(target, key) {
        if (!this.has(target, key)) return undefined
        return { enumerable: true, configurable: true, writable: true, value: this.get(target, key) }
      },
    })
  }

  /** 解析 'a/b/name' → [{ store, mod, name }]；无命名空间时在 root 和非命名空间模块中查找 */
  _resolveTargets(type) {
    const [ns, name] = splitType(type)
    if (ns) {
      const mod = this._modules.get(ns)
      return mod && mod.namespaced ? [{ mod, name }] : []
    }
    const list = []
    if (this._root) list.push({ mod: this._root, name })
    for (const mod of this._modules.values()) if (!mod.namespaced) list.push({ mod, name })
    return list
  }

  /** 找到 commit/dispatch 的处理函数（先查映射表，再查同名 action） */
  _resolveHandlers(type, kind) {
    const handlers = []
    for (const { mod, name } of this._resolveTargets(type)) {
      const mapping = mod[kind][name]
      const instance = this._instance(mod)
      if (typeof mapping === 'function') {
        handlers.push((payload) => mapping(instance, payload, this))
      } else {
        const actionName = typeof mapping === 'string' ? mapping : name
        if (typeof instance[actionName] === 'function') {
          handlers.push((payload) => instance[actionName](payload))
        }
      }
    }
    return handlers
  }

  _getGetter(type) {
    // Pinia 的 getter、state 都挂在 store 实例上；这里宽松处理：同名属性即视为 getter
    // （getters['user/byId'](1) 这种返回函数的 getter 也能正常工作）
    for (const { mod, name } of this._resolveTargets(type)) {
      const instance = this._instance(mod)
      if (!name.startsWith('$') && !name.startsWith('_') && name in instance) {
        return { found: true, value: instance[name] }
      }
    }
    return { found: false, value: undefined }
  }

  _createGettersProxy() {
    const store = this
    return new Proxy(Object.create(null), {
      get(_, key) {
        if (typeof key !== 'string') return undefined
        const { found, value } = store._getGetter(key)
        if (!found && isDev && !IGNORED_KEYS.has(key)) warn(`unknown getter: ${key}`)
        return value
      },
      set(_, key) {
        warn(`getters are read-only, set "${String(key)}" ignored.`)
        return true
      },
      has(_, key) {
        return typeof key === 'string' && store._getGetter(key).found
      },
    })
  }

  /** 模块局部上下文（供 mapXxx 带命名空间时使用） */
  _getModuleContext(ns, helper) {
    if (!this._modules.has(ns)) {
      warn(`module namespace not found in ${helper}(): ${ns}/`)
      return null
    }
    let getters = this._localGettersCache.get(ns)
    if (!getters) {
      const store = this
      getters = new Proxy(Object.create(null), {
        get: (_, key) => (typeof key === 'string' ? store.getters[`${ns}/${key}`] : undefined),
        has: (_, key) => typeof key === 'string' && store._getGetter(`${ns}/${key}`).found,
      })
      this._localGettersCache.set(ns, getters)
    }
    return {
      state: this._stateAt(ns),
      getters,
      // 与 Vuex 一致：options.root 为 true 时按全局 type 处理（对象风格时 options 在第二个参数）
      commit: (type, payload, options) => {
        const args = unifyObjectStyle(type, payload, options)
        const full = args.options && args.options.root ? args.type : `${ns}/${args.type}`
        return this.commit(full, args.payload)
      },
      dispatch: (type, payload, options) => {
        const args = unifyObjectStyle(type, payload, options)
        const full = args.options && args.options.root ? args.type : `${ns}/${args.type}`
        return this.dispatch(full, args.payload)
      },
    }
  }

  // ---------- Vuex 公共 API ----------

  get state() {
    return this._stateAt('')
  }

  set state(_) {
    warn('use store.replaceState() to explicit replace store state.')
  }

  get getters() {
    return this._getters
  }

  commit(_type, _payload, _options) {
    const { type, payload } = unifyObjectStyle(_type, _payload, _options)
    const handlers = this._resolveHandlers(type, 'mutations')
    if (!handlers.length) {
      console.error(`${PREFIX} unknown mutation type: ${type}`)
      return
    }
    handlers.forEach((h) => h(payload))
    const mutation = { type, payload }
    this._subscribers.slice().forEach((sub) => sub(mutation, this.state))
  }

  dispatch(_type, _payload) {
    const { type, payload } = unifyObjectStyle(_type, _payload)
    const action = { type, payload }
    const handlers = this._resolveHandlers(type, 'actions')
    if (!handlers.length) {
      console.error(`${PREFIX} unknown action type: ${type}`)
      return
    }

    const subs = this._actionSubscribers.slice()
    const runHook = (hook, ...args) => {
      subs.forEach((sub) => {
        try {
          sub[hook] && sub[hook](action, this.state, ...args)
        } catch (e) {
          if (isDev) console.error(`${PREFIX} error in ${hook} action subscribers:`, e)
        }
      })
    }

    runHook('before')
    const results = handlers.map((h) => Promise.resolve(h(payload)))
    const result = results.length > 1 ? Promise.all(results) : results[0]

    return result.then(
      (res) => {
        runHook('after')
        return res
      },
      (error) => {
        runHook('error', error)
        throw error
      },
    )
  }

  subscribe(fn, options) {
    return genericSubscribe(fn, this._subscribers, options)
  }

  subscribeAction(fn, options) {
    const sub = typeof fn === 'function' ? { before: fn } : fn
    return genericSubscribe(sub, this._actionSubscribers, options)
  }

  watch(getter, cb, options) {
    if (typeof getter !== 'function') throw new Error(`${PREFIX} store.watch only accepts a function.`)
    return vueWatch(() => getter(this.state, this.getters), cb, options)
  }

  replaceState(newState) {
    const apply = (path, value) => {
      if (!isObject(value)) return
      const own = {}
      Object.keys(value).forEach((key) => {
        const child = path ? `${path}/${key}` : key
        if (this._hasModuleOrDescendant(child)) apply(child, value[key])
        else own[key] = value[key]
      })
      const mod = path ? this._modules.get(path) : this._root
      if (mod) this._instance(mod).$patch(own)
    }
    apply('', newState)
  }

  registerModule(path, def) {
    const p = normalizePath(path)
    if (!p) throw new Error(`${PREFIX} cannot register the root module by using registerModule.`)
    this._modules.set(p, normalizeModule(p, def))
    this._nodeCache.clear()
    this._localGettersCache.clear()
  }

  unregisterModule(path) {
    const p = normalizePath(path)
    if (!this._modules.delete(p)) warn(`trying to unregister module '${p}', which is not registered`)
    this._nodeCache.clear()
    this._localGettersCache.clear()
  }

  hasModule(path) {
    return this._modules.has(normalizePath(path))
  }

  hotUpdate() {
    warn('hotUpdate() is a no-op in vuex-compat, Pinia handles HMR via acceptHMRUpdate().')
  }

  /** 迁移期便利方法：直接拿到某命名空间对应的 Pinia store 实例 */
  getPiniaStore(path = '') {
    const p = normalizePath(path)
    const mod = p ? this._modules.get(p) : this._root
    return mod ? this._instance(mod) : undefined
  }
}

// Vue / devtools / 打印时会探测这些 key，不应报 unknown getter
const IGNORED_KEYS = new Set(['__v_isRef', '__v_isReactive', '__v_raw', '__v_skip', '__v_isReadonly', 'toJSON', 'then', 'constructor'])

function genericSubscribe(fn, subs, options) {
  if (subs.indexOf(fn) < 0) {
    options && options.prepend ? subs.unshift(fn) : subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) subs.splice(i, 1)
  }
}

// ---------- 工厂 & 组合式 API ----------

export function createCompatStore(options) {
  return new CompatStore(options)
}

export function useStore(key = null) {
  return inject(key !== null ? key : storeKey)
}

// ---------- map 辅助函数（签名与 Vuex 一致） ----------

function normalizeMap(map) {
  if (!isObject(map)) return []
  return Array.isArray(map) ? map.map((key) => ({ key, val: key })) : Object.keys(map).map((key) => ({ key, val: map[key] }))
}

function normalizeNamespace(fn) {
  return (namespace, map) => {
    if (typeof namespace !== 'string') {
      map = namespace
      namespace = ''
    } else {
      namespace = normalizePath(namespace)
    }
    return fn(namespace, map)
  }
}

function currentStore(vm) {
  return (vm && vm.$store) || activeStore
}

export const mapState = normalizeNamespace((namespace, states) => {
  const res = {}
  normalizeMap(states).forEach(({ key, val }) => {
    res[key] = function mappedState() {
      const store = currentStore(this)
      let state = store.state
      let getters = store.getters
      if (namespace) {
        const ctx = store._getModuleContext(namespace, 'mapState')
        if (!ctx) return
        state = ctx.state
        getters = ctx.getters
      }
      return typeof val === 'function' ? val.call(this, state, getters) : state[val]
    }
    res[key].vuex = true
  })
  return res
})

export const mapGetters = normalizeNamespace((namespace, getters) => {
  const res = {}
  normalizeMap(getters).forEach(({ key, val }) => {
    const type = namespace ? `${namespace}/${val}` : val
    res[key] = function mappedGetter() {
      const store = currentStore(this)
      if (namespace && !store._getModuleContext(namespace, 'mapGetters')) return
      return store.getters[type]
    }
    res[key].vuex = true
  })
  return res
})

function makeMapMethods(kind, helperName) {
  return normalizeNamespace((namespace, map) => {
    const res = {}
    normalizeMap(map).forEach(({ key, val }) => {
      res[key] = function mappedMethod(...args) {
        const store = currentStore(this)
        let fn = store[kind]
        if (namespace) {
          const ctx = store._getModuleContext(namespace, helperName)
          if (!ctx) return
          fn = ctx[kind]
        }
        return typeof val === 'function' ? val.apply(this, [fn, ...args]) : fn.apply(store, [val, ...args])
      }
    })
    return res
  })
}

export const mapMutations = makeMapMethods('commit', 'mapMutations')
export const mapActions = makeMapMethods('dispatch', 'mapActions')

export function createNamespacedHelpers(namespace) {
  return {
    mapState: mapState.bind(null, namespace),
    mapGetters: mapGetters.bind(null, namespace),
    mapMutations: mapMutations.bind(null, namespace),
    mapActions: mapActions.bind(null, namespace),
  }
}

// 让 `import { createStore } from 'vuex'` 被别名到本文件时给出明确提示
export function createStore() {
  throw new Error(`${PREFIX} createStore() is not supported. Rewrite modules as Pinia stores and use createCompatStore().`)
}

export default {
  CompatStore,
  createCompatStore,
  useStore,
  storeKey,
  mapState,
  mapGetters,
  mapMutations,
  mapActions,
  createNamespacedHelpers,
}
