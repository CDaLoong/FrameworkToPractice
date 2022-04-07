// 采用 Proxy 实现响应式系统，通过劫持对象的 getter 和 setter 来实现

// 存储副作用函数
const bucket = new WeakMap()

// 当前激活的副作用函数
let activeEffect
// effect 栈
const effectStack = []

// 用于注册副作用函数
function effect(fn, options = {}) {
    const effectFn = () => {
        // 调用 cleanup 函数清除该副作用函数绑定的属性直接的连接关系，这样每次注册之前都会先移除其他的副作用函数
        cleanup(effectFn)
        // 当调用 effect 注册副作用函数时，将副作用函数 fn 复制给 activeEffect
        activeEffect = effectFn
        // 立即执行副作用函数
        // 在调用 effect 注册副作用函数前将其副作用函数压入栈中
        effectStack.push(effectFn)
        // 将 fn 的执行结果存储到 res 中
        const res = fn()
        // 在当前副作用函数执行完毕后，将当前副作用函数弹出栈，并把 activeEffect 还原为之前的值
        effectStack.pop()
        activeEffect = effectStack[effectStack.length - 1]
        // 将 res 作为 effectFn 的返回值
        return res
    }

    // 将 options 挂载到 effectFn 上
    effectFn.options = options

    // activeEffect.deps 数组用来存储所有与该副作用函数相关联的依赖集合
    effectFn.deps = []
    // 只有非 lazy 的时候才执行
    if (!options.lazy) {
        // 执行副作用函数
        effectFn()
    }
    // 将副作用函数作为返回值返回
    return effectFn
}

function cleanup(effectFn) {
    // 遍历 effectFn.deps 数组
    for(let i = 0; i < effectFn.deps.length; i++) {
        // deps 是依赖集合
        const deps = effectFn.deps[i]
        // 将 effectFn 从依赖集合中移除
        deps.delete(effectFn)
    }
    // 重置 effectFn.deps 数组
    effectFn.deps.length = 0
}

// 生成代理函数
function getProxyObj(obj) {
    return new Proxy(obj, {
        // 拦截读取操作
        get(target, key) {
            // 处理副作用函数
            track(target, key)
            // 返回属性值
            return target[key]
        },
        // 拦截设置操作
        set(target, key, value) {
            // 给属性重新赋值
            target[key] = value
            // 执行副作用函数
            trigger(target, key)
        }
    })
}
// 在 getter 拦截函数内调用 track 函数追踪变化
function track(target, key) {
    // 没有副作用函数，直接 return
    if (!activeEffect) return
    // 根据 target 从副作用函数库里取出 depsMap，它是一个 Map 类型：key --> effects
    let depsMap = bucket.get(target)
    // 如果不存在 depsMap，就新建一个 Map 并与 target 相关联
    if (!depsMap) bucket.set(target, (depsMap = new Map()))
    // 再根据 key 从 depsMap 中获取 deps，它是一个 Set 类型，里面存储着所有与当前 key 相关联的副作用函数：effects
    let deps = depsMap.get(key)
    // 如果 deps 不存在，同样新建一个 Set 并于 key 相关联
    if (!deps) depsMap.set(key, (deps = new Set()))
    // 将当前激活的副作用函数存储到副作用函数库中
    deps.add(activeEffect)
    // 将其添加到 activeEffect.deps 数组中，deps 数组就是一个与当前副作用函数存在联系的依赖集合
    activeEffect.deps.push(deps)
}

// 在setter 拦截函数中调用 trigger 函数触发变化
function trigger(target, key) {
    //  根据 target 从 副作用函数库中取出 depsMap，它是 key --> effects
    const depsMap = bucket.get(target)
    // 如果不存在 depsMap，直接返回
    if (!depsMap) return
    // 根据 key 取得所有的副作用函数 effects
    const effects = depsMap.get(key)

    const effectsToRun = new Set(effects)
    
    effects && effects.forEach(effect => {
        // 如果 trigger 触发执行的副作用函数与当前正在执行的副作用函数相同，则不触发执行，避免如 i++ 等的重复触发（递归调用）
        if (effect !== activeEffect) effectsToRun.add(effect)
    })
    // 执行副作用函数
    effectsToRun.forEach(effect => {
        // 如果一个副作用函数存在调度器，则调用该调度器，并将副作用函数作为参数传递
        if (effect.options.scheduler) {
            effect.options.scheduler(effect)
        } else {
            // 否则直接执行副作用函数
            effect()
        }
    })
    // effects && effects.forEach(effect => effect())
}

// 定义一个任务队列
const jobQueue = new Set()
// 使用 Promise.resolve() 创建一个 promise 实例，我们用它将一个任务添加到微任务队列
const p = Promise.resolve()

// 一个代表是否正在刷新队列的标志
let isFlushing = false
// 刷新任务队列函数
function flushJob() {
    // 如果任务队列正在刷新，什么也不做
    if (isFlushing) return
    // 开启任务队列刷新
    isFlushing = true
    // 在微任务中刷新队列
    p.then(() => {
        jobQueue.forEach(job => job())
    }).finally(() => {
        // 刷新队列结束
        isFlushing = false
    })
}


// 所谓 watch，其本质就是观测一个响应式数据，当数据发生变化的时候，通知并执行响应的回调函数
function watch(source, cb, options) {
    let getter
    // 如果 source 是函数，说明用户传的是 getter，直接把 source 赋值给 getter
    if (typeof source === 'function') {
        getter = source
    } else {
        // 否则按照原来的实现方式递归读取
        getter = () => traverse(source)
    }
    // 定义新值与旧值
    let newValue, oldValue

    // 用 cleanup 来存储用户注册的过期回调
    let cleanup
    // 定义 onInvalidate 函数
    function onInvalidate(fn) {
        cleanup = fn
    }

    // 提取 scheduler 调度函数为一个独立的 job 函数
    const job = () => {
        // 在 schedule 中再次执行副作用函数，得到的是新值
        newValue = effectFn()
        // 在执行回调函数 cb 之前，先调用过期回调
        if (cleanup) cleanup()
        // 当数据变化时，调用回调函数 cb，传入新值和旧值，以及过期回调函数
        cb(newValue, oldValue, onInvalidate)
        // 更新旧值，否则下一次会得到错误的旧值
        oldValue = newValue
    }
    // 使用 effect 注册副作用函数时，开启 lazy 选项，并把返回值存储到 effectFn 中以便后续手动调用
    const effectFn = effect(
        // 调用 traverse 函数，递归触发读取操作，从而建立联系
        () => getter(),
        {   
            lazy: true,
            // 使用 job 函数作为调度器函数
            scheduler: () => {
                // 在调度函数中判断 flush 是否为 post，如果是，将其放到微任务队列中执行
                if (options.flush === 'post') {
                    const p = Promise.resolve();
                    p.then(job)
                } else job()
            }
        }
    )
    if (options.immediate) {
        // 当 immediate 为 true 时立即执行 job，从而触发回调执行
        job()
    } else {
        // 手动调用副作用函数，拿到的值就是旧值
        oldValue = effectFn()
    }
}

function traverse (value, seen = new Set()) {
    // 如果要读取的数据是原始值，活着已经被读取过了，那么直接 return
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    // 将数据添加到 seen 中，代表已经遍历的读取过了，避免循环引用引起的死循环
    seen.add(value)
    // 暂时不考虑数组等其他数据结构，假设 value 就是一个对象，使用 for...in 循环读取对象的每一个值，并递归地调用 traverse 进行处理
    for (const k in value) {
        traverse(value[k], seen)
    }
    return value
}

const obj = getProxyObj({ foo: 1 })
// watch(obj, () => {
//     console.log('数据发生变化了')
// })

let finalData
watch(() => obj.foo, async (newValue, oldValue, onInvalidate) => {
    console.log(newValue, oldValue, '数据发生变化了')
    // 定义一个标志，代表当前副作用函数是否过期，默认为 false，代表没有过期 
    let expired = false
    // 调用 onInvalidate 函数注册一个过期回调
    onInvalidate(() => {
        // 当过期时，expired 为true
        expired = true
    })
    let res
    // 模拟网络请求
    await Promise.resolve().then(() => {
        console.log('执行Promise')
        res = 'test'
    })
    // 只有当副作用函数的执行没有过期时，才会执行后续操作
    if (!expired) finalData = res
    console.log(finalData)
}, {
    // 回调函数会在创建时立即执行一次
    immediate: true,
    // flush: 'post',
})
obj.foo++
obj.foo++

