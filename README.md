# vuex-compat：Vuex 4 → Pinia 渐进迁移兼容层

底层用 Pinia，对外模拟 Vuex 4 的 API。业务模块改写成 Pinia store 以后，旧代码不用改；新代码直接用 Pinia。

## 先判断：是否需要这个兼容层？

**结论：大多数项目不需要，或者只需要在很短的过渡期里用。** 接入前请先读完这一节。

### 为什么可能没必要

**1. Vuex 4 和 Pinia 本来就可以在同一个项目里共存。**
两者在 Vue 3 下互不干扰，可以同时 `app.use(vuex)` 和 `app.use(pinia)`。最稳妥的渐进迁移是：每次迁一个模块，同时把这个模块的调用方改掉，其他模块继续用 Vuex。不需要任何兼容层，系统也随时处于"真实"状态。

**2. 兼容层省掉的只是比较容易的那部分。**
- 难的是改写模块定义：getter 的 `rootState`、action 的 `context`、跨模块调用。这部分兼容层帮不上，必须手工改。
- 它省掉的是改调用方，而调用方的改动大多很机械。Pinia 自带的 map 辅助函数和 Vuex 几乎是一一对应的，用 codemod 或正则批量替换就能完成大半：

```js
mapState('user', ['name'])        →  mapState(useUserStore, ['name'])
mapGetters('user', ['fullName'])  →  mapState(useUserStore, ['fullName'])
mapMutations('user', ['setName']) →  mapActions(useUserStore, ['setName'])
mapActions('user', ['login'])     →  mapActions(useUserStore, ['login'])
```

**3. 兼容层本身会带来新风险。**
- 有十几条和 Vuex 的行为差异（见下文[不支持的场景与行为差异](#不支持的场景与行为差异)），比如 `subscribe` 漏掉变更、`replaceState` 变成合并、getters 不能枚举。这些问题都不会报错，只会悄悄表现得和以前不一样，比"改完后编译报错"更难发现。
- 它是一层额外的间接调用。调试时调用栈和 Devtools 里看到的东西都和代码对不上。
- 最大的风险是**临时方案变成永久方案**。旧代码一直能跑，就没人去改，最后项目里同时存在两套写法，再加一层只有少数人懂的胶水代码。

### 什么情况下值得用

- **调用点特别多且分散**：几百上千处，涉及多个团队，或者有不能改的代码（比如别的团队维护的公共组件）。
- **必须马上去掉 `vuex` 依赖**：比如包体积、安全审计，或者 Vuex 与其他依赖冲突。
- **有大量组件外的 `import store from '@/store'` 用法**：比如路由守卫、axios 拦截器、工具函数。这类代码不好用 codemod 改，兼容层在这里的收益最大。

### 怎么决定

1. **先量化**：统计项目里各类用法的数量和涉及的文件数，例如：
   ```bash
   grep -rnE '\$store\.'                                       src | wc -l
   grep -rnE 'map(State|Getters|Mutations|Actions)\('         src | wc -l
   grep -rlE "import store from ['\"]@/store['\"]"             src | wc -l
   grep -rnE 'createNamespacedHelpers|useStore\(\)'            src | wc -l
   ```
2. **默认方案**：Vuex 和 Pinia 共存，每次迁一个模块，同时用 codemod 改掉这个模块的调用方，迁完一个删一个 Vuex 模块。
3. **兼容层只作为补充**：如果统计后发现某一类调用（比如组件外的 `store.state.xxx`）特别难改，再只针对这部分用兼容层，并**给它设一个删除的截止时间**。

## 接入步骤

### 1. 把 Vuex 模块改写成 Pinia store

| Vuex | Pinia |
| --- | --- |
| `namespaced` 模块 `user` | `defineStore('user', …)` |
| 嵌套模块 `account/profile` | `defineStore('account/profile', …)`（id 随意，路径在步骤 2 里配置） |
| `state` | `state` |
| `getters: { x: (state, getters, rootState) => … }` | `getters: { x(state) { … this.otherGetter … } }`，跨模块时直接调用 `useOtherStore()` |
| `mutations: { setName(state, v) {} }` | `actions: { setName(v) { this.name = v } }` |
| `actions: { fetch({ commit }, p) {} }` | `actions: { async fetch(p) { this.setName(…) } }` |

### 2. 用兼容层替换原来的 `store/index.js`

```js
// src/store/index.js
import { createPinia } from 'pinia'
import { createCompatStore } from './vuex-compat'
import { useRootStore } from './modules/root'
import { useUserStore } from './modules/user'

export const pinia = createPinia()

const store = createCompatStore({
  pinia,
  root: useRootStore,                // 原根模块，可省略
  modules: {
    user: {
      useStore: useUserStore,
      // 可选：原 mutation / action 名称和新 action 名称不一致时的映射
      mutations: {
        SET_TOKEN: 'setTokenSync',                     // 指向某个 action
        SET_NAME: (s, name) => { s.name = name },     // 或者直接写成函数，省得为简单 mutation 单独加 action
      },
      actions: { setToken: 'login' },
    },
    'account/profile': useProfileStore,              // 嵌套模块用路径作为 key
    counter: { useStore: useCounterStore, namespaced: false }, // 非命名空间模块
  },
})

export default store   // 原来 `import store from '@/store'` 再访问 store.state.xxx 的代码保持可用
```

```js
// main.js
import store, { pinia } from './store'
app.use(pinia).use(store)
```

### 3. 替换 `vuex` 的导入（二选一）

- **构建别名，不改业务代码**：
  ```js
  // vite.config.js
  resolve: { alias: { vuex: path.resolve(__dirname, 'src/store/vuex-compat/index.js') } }
  // webpack: resolve.alias.vuex$ = ...
  ```
- **全局替换**：`from 'vuex'` → `from '@/store/vuex-compat'`

## 支持的 API

| API | 行为 |
| --- | --- |
| `store.state.a.b.x` | 读写对应 Pinia store 的 `$state`，并保持响应式。叶子模块直接返回 Pinia 的 `$state` |
| `store.getters['a/b/x']`、`store.getters.x` | 读取 Pinia getter（也包括返回函数的 getter） |
| `store.commit(type, payload)` / 对象风格 | 先查 `mutations` 映射表，再调用同名 action；支持解构后调用 |
| `store.dispatch(type, payload)` | 先查 `actions` 映射表，再调用同名 action；返回 Promise |
| `mapState / mapGetters / mapMutations / mapActions` | 签名与 Vuex 相同，支持命名空间参数和函数形式 |
| `createNamespacedHelpers`、`useStore()`、`storeKey` | 与 Vuex 相同 |
| `subscribe`、`subscribeAction` | 支持（含 before/after/error 和 prepend） |
| `watch`、`replaceState`、`registerModule`、`unregisterModule`、`hasModule` | 支持 |
| `store.getPiniaStore('user')` | 额外提供：拿到 Pinia 实例，方便迁移期间过渡 |

## 不支持的场景与行为差异

下面每一条都在 `tests/limitations.test.js` 里有对应用例，确保文档和实际行为一致。

图例：❌ 不支持　⚠️ 支持，但行为和 Vuex 不同

### 一、模块定义（这部分必须改写，兼容层不处理）

| | 场景 | 说明 / 处理方式 |
| --- | --- | --- |
| ❌ | 直接使用 Vuex 模块对象（`state / mutations / actions / getters / modules`） | 必须先改写成 `defineStore`，兼容层只负责**调用侧**的兼容 |
| ❌ | getter 的 `(state, getters, rootState, rootGetters)` 参数 | 改成 Pinia 写法：用 `this` 访问本 store，跨模块读取时调用 `useXxxStore()` |
| ❌ | action 的 `context` 参数（`{ commit, dispatch, state, rootState, getters, rootGetters }`） | Pinia action 只接收 payload。改为 `this.xxx()` 或 `useOtherStore().xxx()` |
| ❌ | 模块**内部**的 `commit/dispatch(type, payload, { root: true })` | 同上，直接调用目标 store。注意：组件里命名空间版 `mapMutations/mapActions` 的函数形式支持 `{ root: true }` |
| ❌ | 命名空间父模块下的**非命名空间子模块**（Vuex 会让子模块继承父模块的命名空间，比如 `getters['parent/g']`） | 兼容层会把 `namespaced: false` 的模块一律当作全局模块。处理方式：把子模块的 getter/action 合并进父 store，或者给子模块开启命名空间并修改调用方 |
| ❌ | `registerModule(path, vuexModuleObject)`（包括 `vuex-router-sync` 这类依赖它的库） | 只接受 Pinia 的 `useStore` 函数或 `{ useStore, ... }` 配置；`preserveState` 等选项会被忽略 |

### 二、commit / dispatch

| | 场景 | 说明 / 处理方式 |
| --- | --- | --- |
| ⚠️ | mutation 和 action **同名**（比如都叫 `login`） | Pinia 里只能有一个同名 action，所以 commit 和 dispatch 调到的是同一个函数。处理方式：在模块配置的 `mutations` / `actions` 映射表里把它们分别指向不同的 action |
| ⚠️ | commit 调到了异步 action | 不会等待 action 完成，`subscribe` 回调会在异步逻辑完成之前触发。mutation 应保证是同步的 |
| ⚠️ | 找不到对应的 type | 和 Vuex 一样会 `console.error`，不会抛异常；区别是生产环境也会打印 |

### 三、state

| | 场景 | 说明 / 处理方式 |
| --- | --- | --- |
| ⚠️ | `store.state` 以及**含子模块**的节点（比如有 `account/profile` 时的 `store.state.account`） | 是兼容层的 Proxy，**不是** reactive 对象：`isReactive()` 返回 false，`store.state.account !== useAccountStore().$state`。读写本身是响应式的。叶子模块（比如 `store.state.user`）返回的就是 Pinia 的 `$state`，没有这个问题 |
| ❌ | 把上面这种节点直接作为 `watch` 的 source：`watch(store.state.account, cb)` | Vue 会报 Invalid watch source，回调不会触发。改用函数形式：`watch(() => store.state.account, cb, { deep: true })` |
| ❌ | 整体替换模块 state：`store.state.user = {...}` | 会被忽略并打印警告。改用 `replaceState`、`useUserStore().$patch()` 或 `$state = ...` |
| ⚠️ | 没有配置 `root` 时写入根级字段：`store.state.foo = 1` | 会被忽略并打印警告 |
| ⚠️ | 模块路径和 root state 的 key 重名 | 模块优先，root 里的同名字段无法通过 `store.state` 访问 |
| ❌ | strict 模式 | 在 commit 之外修改 state 不会报错 |
| ⚠️ | `replaceState(newState)` | 用 Pinia `$patch` 实现，是**合并**而不是整体替换：没有传入的字段会保留，嵌套对象会深合并（数组会整体替换）。如果确实需要整体替换，对每个 store 直接赋值 `$state` |

### 四、getters

| | 场景 | 说明 / 处理方式 |
| --- | --- | --- |
| ❌ | 枚举 getters：`Object.keys(store.getters)`、`for...in`、`{ ...store.getters }` | 结果为空。Pinia 在生产环境下无法枚举出某个 store 有哪些 getter |
| ⚠️ | 查找规则比 Vuex 宽松 | `getters['user/name']` 会返回 state 里的字段，`getters['user/setName']` 会返回 action 函数。Vuex 中这两者都是 undefined |
| ⚠️ | 多个非命名空间模块有同名 getter | 返回第一个（root 优先，然后按注册顺序）。Vuex 遇到这种情况会报 duplicate getter |

### 五、订阅、插件、生命周期

| | 场景 | 说明 / 处理方式 |
| --- | --- | --- |
| ⚠️ | `subscribe` / `subscribeAction` | **只能捕获经过兼容层 `commit` / `dispatch`（包括 mapMutations/mapActions）发起的调用**。新代码直接调用 Pinia action、直接修改 state 都不会触发 |
| ❌ | 依赖 `subscribe` 的 Vuex 插件（比如 `vuex-persistedstate`、日志插件） | 迁移得越多，漏掉的变更就越多。请改用 Pinia 插件（`pinia-plugin-persistedstate`）或者 `$subscribe` / `$onAction` |
| ❌ | 依赖 Vuex 内部属性的代码或插件：`store._vm`、`_mutations`、`_actions`、`_modules`、`_modulesNamespaceMap`、`_state` | 这些属性都不存在 |
| ⚠️ | `unregisterModule` | 只是从兼容层里移除，Pinia 中的状态仍然保留，重新注册后还是旧值。如需清理，调用 `useXxxStore().$reset()` / `$dispose()` |
| ❌ | `hotUpdate` | 空操作，HMR 改用 Pinia 的 `acceptHMRUpdate` |
| ⚠️ | 在 `app.use(pinia)` **之前**访问 `store.state.xxx`（比如在路由守卫或模块顶层代码里） | Pinia 的行为：这时创建出来的 store **不会应用 `pinia.use()` 注册的插件**（已验证）。请确保先 `app.use(pinia)` 再访问 store |

### 六、导出、类型与工具链

| | 场景 | 说明 / 处理方式 |
| --- | --- | --- |
| ❌ | `createStore()`、`new Store()`、`import Vuex from 'vuex'; Vuex.Store`、`store instanceof Store` | `createStore` 会直接抛错提示；`Store` 类没有导出（对应的类是 `CompatStore`） |
| ❌ | TypeScript 类型：`Store<State>`、`useStore<State>()`、`declare module '@vue/runtime-core'` 里给 `$store` 声明的类型 | 兼容层是纯 JS，没有附带类型声明。如果用别名替换 `vuex`，还需要在 tsconfig `paths` 中处理类型 |
| ⚠️ | Vue Devtools | Vuex 面板不会再出现，状态和 action 显示在 Pinia 面板里，commit 记录为对应 action 的调用 |
| ⚠️ | SSR | 组件外 `import store from '@/store'` 拿到的是模块级单例（和 Vuex 的常见写法一样），多请求之间会共享状态。SSR 场景应该按请求分别创建 pinia 和兼容 store |

## 推荐的迁移节奏

如果按[先判断：是否需要这个兼容层？](#先判断是否需要这个兼容层)的结论决定使用兼容层：

1. 接入兼容层，所有模块改写成 Pinia，旧调用方式保持不变（`npm test` 里有覆盖各种用法的用例）。接入前先逐条核对[不支持的场景与行为差异](#不支持的场景与行为差异)，排查项目中是否有命中的用法。
2. 新代码一律 `useXxxStore()`，禁止再新增 `$store` / Vuex map 辅助函数的用法（可以用 ESLint `no-restricted-imports` / `no-restricted-syntax` 限制）。
3. 旧调用方按模块逐个改成直接使用 Pinia。每改完一批，用第 1 步的 grep 统计剩余调用点，跟踪进度。
4. 调用点清零后删除兼容层，以及构建配置里的 `vuex` 别名。给这一步设一个明确的截止时间，避免兼容层变成永久方案。

如果不使用兼容层：Vuex 4 和 Pinia 共存，每次迁一个模块，同时改掉该模块的所有调用方，然后删除对应的 Vuex 模块；所有模块迁完后移除 `vuex` 依赖。
