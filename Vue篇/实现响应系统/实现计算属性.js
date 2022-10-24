// 采用 Proxy 实现响应式系统，通过劫持对象的 getter 和 setter 来实现

// 存储副作用函数
const bucket = new WeakMap()

// 当前激活的副作用函数，每次生成新的副作用函数都会触发代理对象的 getter，从而将副作用函数与代理对象绑定
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
        get(target, key, receiver) {
            // 处理副作用函数
            track(target, key)
            // 使用 Reflect.get 返回读取到的属性值
            return Reflect.get(target, key, receiver)
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


// const testObj = getProxyObj({ name: 'Tom', age: 18 })

// const effectFn = effect(
//     // 指定了 lazy 选项，这个函数就不会立即执行
//     () => {
//         return testObj
//     },
//     // options
//     {
//         // 调度器 scheduler 是一个函数
//         // scheduler(fn) {
//         //     // 将副作用函数放到微任务队列里执行
//         //     // const p = Promise.resolve()
//         //     // p.then(() => fn())
            
//         //     // 每次调度时，将副作用函数添加到 jobQueue 队列中
//         //     jobQueue.add(fn)
//         //     // 调用flushJob 刷新任务队列
//         //     flushJob()
//         // },
//         lazy: false
//     }
// )

// const value = effectFn()

// console.log(value)
// value.age++
// value.age++
// testObj.age++


// 所谓 computed，就是当依赖的响应式数据发生变化时，收到通知，并根据变化后的数据重新执行相应的回调函数
function computed (getter) {
    // value 用来缓存上一次计算的值
    let value
    // 当该值为 true 时，不需要重新计算
    let dirty = true

    // getter 作为副作用函数，创建一个 lazy 的 effect
    const effectFn = effect(getter, {
        lazy: true,
        // 添加调度器，在调度器中重新设置 dirty 为 true
        scheduler() {
            dirty = true,
            // 当计算属性依赖的响应式数据发生变化的时候，手动调用 trigger 函数触发响应
            trigger(obj, 'value')
        }
    })
    const obj = {
        // 当读取 value 的时候才执行 effectFn
        get value() {
            if (dirty) {
                value = effectFn()
                dirty = false
            }
            // 当读取 value 的时候，手动调用 track 函数进行追踪
            track(obj, 'value')
            return value
        }
    }
    return obj
}

let testNum = 0
const obj = getProxyObj({ foo: 1, bar: 2 })
const sumRes = computed(() => { testNum++; return obj.foo + obj.bar})

console.log(sumRes.value)
console.log(sumRes.value)
console.log(sumRes.value)
obj.foo = 2
console.log(testNum)
console.log(sumRes)