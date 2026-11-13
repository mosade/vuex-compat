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
import { inject, shallowRef, watch as vueWatch } from 'vue'

export const storeKey = 'store'

let activeStore = null
// 必须直接引用 process.env.NODE_ENV，打包工具才会在构建时把它替换成字面量；
// 没有替换、运行时又不存在 process 的环境（比如直接在浏览器里用 ESM）会进入 catch，按开发环境处理
const isDev = (() => {
  try {
    return process.env.NODE_ENV !== 'production'
  } catch {
    return true
  }
})()
const PREFIX = '[vuex-compat]'

function warn(msg) {
  if (isDev) console.warn(`${PREFIX} ${msg}`)
}

function isObject(v) {
  return v !== null && typeof v === 'object'
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

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
    this._contextCache = new Map()
    // 模块注册表本身不是响应式的；用这个版本号让依赖注册表的 computed / watch 在注册、注销模块后重新计算
    this._version = shallowRef(0)
    this._prefixes = new Set() // 所有模块路径及其祖先路径
    this._children = new Map() // 路径 → 直接子段名列表（根路径为 ''）

    Object.keys(modules).forEach((p) => {
      const path = normalizePath(p)
      this._modules.set(path, normalizeModule(path, modules[p]))
    })
    this._rebuildIndex()

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

  /** 注册表变化后重建索引、清空缓存，并通知依赖方 */
  _rebuildIndex() {
    const prefixes = new Set()
    const children = new Map()
    const addChild = (parent, seg) => {
      let set = children.get(parent)
      if (!set) children.set(parent, (set = new Set()))
      set.add(seg)
    }
    for (const path of this._modules.keys()) {
      const segs = path.split('/')
      for (let i = 0; i < segs.length; i++) {
        prefixes.add(segs.slice(0, i + 1).join('/'))
        addChild(segs.slice(0, i).join('/'), segs[i])
      }
    }
    this._prefixes = prefixes
    this._children = new Map([...children].map(([k, v]) => [k, [...v]]))
    this._nodeCache.clear()
    this._contextCache.clear()
    this._version.value++
  }

  /** 读取版本号以建立响应式依赖 */
  _track() {
    // eslint-disable-next-line no-unused-expressions
    this._version.value
  }

  _hasModuleOrDescendant(path) {
    this._track()
    return this._prefixes.has(path)
  }

  _childSegments(path) {
    this._track()
    return this._children.get(path) || []
  }

  /** 某路径自身的 state（Pinia $state），根路径为 root store 的 state */
  _ownState(path) {
    this._track()
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
    this._track()
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
      // 只认自身属性，避免 'constructor'、'toString' 等 Object.prototype 成员被当成映射或 action
      const mapping = hasOwn(mod[kind], name) ? mod[kind][name] : undefined
      const instance = this._instance(mod)
      if (typeof mapping === 'function') {
        handlers.push((payload) => mapping(instance, payload, this))
      } else {
        const actionName = typeof mapping === 'string' ? mapping : name
        if (hasOwn(instance, actionName) && typeof instance[actionName] === 'function') {
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
      if (!name.startsWith('$') && !name.startsWith('_') && hasOwn(instance, name)) {
        return { found: true, value: instance[name] }
      }
    }
    return { found: false, value: undefined }
  }

  _createGettersProxy() {
    const store = this
    return new Proxy(Object.create(null), {
      get(_, key) {
        // Vue 内部标记（__v_isRef、__v_isShallow 等）与 state 节点的处理保持一致
        if (typeof key !== 'string' || key.startsWith('__v_')) return undefined
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
  /** 检查命名空间是否已注册（会建立响应式依赖，模块注册后 mapXxx 能自动恢复） */
  _assertModule(ns, helper) {
    this._track()
    if (this._modules.has(ns)) return true
    warn(`module namespace not found in ${helper}(): ${ns}/`)
    return false
  }

  /** 模块局部上下文（供 mapXxx 带命名空间时使用），按命名空间缓存，注册表变化时失效 */
  _getModuleContext(ns, helper) {
    if (!this._assertModule(ns, helper)) return null
    let ctx = this._contextCache.get(ns)
    if (ctx) return ctx
    const store = this
    const toFull = (args) => (args.options && args.options.root ? args.type : `${ns}/${args.type}`)
    ctx = {
      get state() {
        return store._stateAt(ns)
      },
      getters: new Proxy(Object.create(null), {
        get: (_, key) => (typeof key === 'string' ? store.getters[`${ns}/${key}`] : undefined),
        has: (_, key) => typeof key === 'string' && store._getGetter(`${ns}/${key}`).found,
      }),
      // 与 Vuex 一致：options.root 为 true 时按全局 type 处理（对象风格时 options 在第二个参数）
      commit: (type, payload, options) => {
        const args = unifyObjectStyle(type, payload, options)
        return store.commit(toFull(args), args.payload)
      },
      dispatch: (type, payload, options) => {
        const args = unifyObjectStyle(type, payload, options)
        return store.dispatch(toFull(args), args.payload)
      },
    }
    this._contextCache.set(ns, ctx)
    return ctx
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
      if (!isObject(value)) {
        warn(`replaceState(): state of "${path || '<root>'}" must be an object, got ${value === null ? 'null' : typeof value}; skipped.`)
        return
      }
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
    this._rebuildIndex()
  }

  /** 与 Vuex 一致：连同所有子模块一起注销 */
  unregisterModule(path) {
    const p = normalizePath(path)
    const prefix = `${p}/`
    const targets = [...this._modules.keys()].filter((k) => k === p || k.startsWith(prefix))
    if (!targets.length) {
      warn(`trying to unregister module '${p}', which is not registered`)
      return
    }
    targets.forEach((k) => this._modules.delete(k))
    this._rebuildIndex()
  }

  hasModule(path) {
    this._track()
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

// 序列化、Promise 判断、打印时会探测这些 key，不应报 unknown getter（__v_* 已在 get 中统一处理）
const IGNORED_KEYS = new Set(['toJSON', 'then', 'constructor'])

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
      if (namespace && !store._assertModule(namespace, 'mapGetters')) return
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
