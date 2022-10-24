// 采用 Proxy 实现响应式系统，通过劫持对象的 getter 和 setter 来实现

// 存储副作用函数
const bucket = new WeakMap()

// 当前激活的副作用函数，每次生成新的副作用函数都会触发代理对象的 getter，从而将副作用函数与代理对象绑定
let activeEffect
// effect 栈
const effectStack = []

const TriggerType = {
    SET: 'SET',
    ADD: 'ADD',
    DELETE: 'DELETE',
}

// 用于注册副作用函数
function effect(fn, options = {}) {
    const effectFn = () => {
        // 调用 cleanup 函数清楚该副作用函数绑定的属性直接的连接关系，这样每次注册之前都会先移除其他的副作用函数
        cleanup(effectFn)
        // 当调用 effect 注册副作用函数时，将副作用函数 fn 复制给 activeEffect
        activeEffect = effectFn
        // 立即执行副作用函数
        // 在调用 effect 注册副作用函数前将其副作用函数压入栈中
        effectStack.push(effectFn)
        fn()
        // 在当前副作用函数执行完毕后，将当前副作用函数弹出栈，并把 activeEffect 还原为之前的值
        effectStack.pop();
        activeEffect = effectStack[effectStack.length - 1]
    }

    // 将 options 挂载到 effectFn 上
    effectFn.options = options

    // activeEffect.deps 数组用来存储所有与该副作用函数相关联的依赖集合
    effectFn.deps = []
    // 执行副作用函数
    effectFn()
}

function cleanup(effectFn) {
    // 遍历 effectFn.deps 数组
    for (let i = 0; i < effectFn.deps.length; i++) {
        // deps 是依赖集合
        const deps = effectFn.deps[i]
        // 将 effectFn 从依赖集合中移除
        deps.delete(effectFn)
    }
    // 重置 effectFn.deps 数组
    effectFn.deps.length = 0
}

const ITERATE_KEY = Symbol()

const arrayInstrumentations = {}
// 一个标记变量，代表是否进行追踪，默认值为true
let shouldTrack = true
['includes', 'indexOf', 'lastIndexOf'].forEach(method => {
    const originMethod = Array.prototype[method]
    arrayInstrumentations[method] = function (...args) {
        // this 是代理对象，现在对象中查找，将结果存储到 res 中
        let res = originMethod.apply(this, args)
        // 如果没有找到，则通过 this.raw 拿到原始数组，再去其中查找并更新 res 的值
        if (res === false) res = originMethod.apply(this.raw, args)
        return res
    }
})
['push', 'pop', 'shift', 'unshift', 'splice'].forEach(method => {
    const originMethod = Array.prototype[method]
    arrayInstrumentations[method] = function (...args) {
        shouldTrack = false
        // this 是代理对象，现在对象中查找，将结果存储到 res 中
        let res = originMethod.apply(this, args)
        shouldTrack = true
        return res
    }
})

// 定义一个Map实例，存储原始对象与代理对象的映射
const reactiveMap = new Map()

// 生成代理函数，是否是浅响应，是否是只读属性
function getProxyObj(obj, isShallow = false, isReadonly = false) {
    // 优先通过原始对象 obj 寻找之前创建的代理对象，如果找到了，直接返回已有的代理对象
    const existionProxy = reactiveMap.get(obj)
    if (existionProxy) return existionProxy
    const proxy = new Proxy(obj, {
        // 拦截读取操作
        get(target, key, receiver) { // receiver 当前对象，可以
            // 代理对象可以通过 raw 属性访问原始数据，有重名风险，这个方法很不妥
            if (key === 'raw') return target

            if (Array.isArray(target) && arrayInstrumentations.hasOwnProperty(key)) {
                return Reflect.get(arrayInstrumentations, key, receiver)
            }

            // 处理副作用函数，非只读的时候才建立响应式联系
            // 如果 key 的类型是 symbol，则不进行追踪
            if (!isReadonly && typeof key !== 'symbol') track(target, key)
            // 得到原始值结果
            const res = Reflect.get(target, key, receiver)
            // 如果是浅响应，直接返回
            if (isShallow) return res
            // 如果是对象，则将结果包装成响应式数据并返回
            if (typeof res === 'object' && res !== null) return getProxyObj(res, isShallow, isReadonly)
            // 使用 Reflect.get 返回读取到的属性值
            return res
        },
        // 拦截 in 操作符读取属性的操作
        has(target, key) {
            track(target, key)
            return Reflect.has(target, key)
        },
        // 间接拦截 for...in 循环
        ownKeys(target) {
            // 将副作用函数与 ITERATE_KEY 关联，如果操作目标是数组，则使用 length 作为 key 去建立响应式的联系
            track(target, Array.isArray(target) ? 'length' : ITERATE_KEY)
            return Reflect.ownKeys(target)
        },
        // 拦截设置操作
        set(target, key, newValue, receiver) {
            // 如果是只读对象，则打印警告信息并返回
            if (isReadonly) {
                console.warn(`属性 ${key} 是只读的`)
                return true
            }
            // 先获取旧值
            const oldValue = target[key]
            // 如果是数组，则判断设置的索引值是否小雨数组长度，如果属性不存在，则说明是在添加属性，否则是设置已有属性
            const type = Array.isArray(target) ? Number(key) < target.length ? TriggerType.SET : TriggerType.ADD : Object.prototype.hasOwnProperty.call(target, key) ? TriggerType.SET : TriggerType.ADD
            // 给属性重新赋值
            const res = Reflect.set(target, key, newValue, receiver)
            // 说明 receiver 就是 target 的代理对象，屏蔽由原型引起的更新，避免不必要的更新操作
            if (target === receiver.raw) {
                // 比较新值与旧值，当不全等的时候，且都不是 NaN 的时候才触发响应
                if (oldValue !== newValue && (oldValue === oldValue || newValue === newValue)) {
                    // 执行副作用函数
                    trigger(target, key, type, newValue)
                }
            }
            return res
        },
        // 拦截删除属性操作
        deleteProperty(target, key) {
            // 如果是只读对象，则打印警告信息并返回
            if (isReadonly) {
                console.warn(`属性 ${key} 是只读的`)
                return true
            }
            // 检查被操作的属性是否是对象自己的属性
            const hadKey = Object.prototype.hasOwnProperty.call(target, key)
            // 使用 Reflect.deleteProperty 完成属性的删除
            const res = Reflect.deleteProperty(target, key)
            // 只有当被删除的属性是对象自己的属性且删除成功时，才触发更新
            if (res && hadKey) {
                trigger(target, key, TriggerType.DELETE)
            }
            return res
        }
    })
    // 存储到 Map 中，避免重复创建
    reactiveMap.set(obj, proxy);
    return proxy;
}
// 在 getter 拦截函数内调用 track 函数追踪变化
function track(target, key) {
    // 没有副作用函数，直接 return
    if (!activeEffect || !shouldTrack) return target[key]
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
    // 将其添加到 activeEffect.deps 数组中
    activeEffect.deps.push(deps)
}

// 在setter 拦截函数中调用 trigger 函数触发变化
function trigger(target, key, type, newValue) {
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

    // 如果操作对象是数组且修改了数组的length值
    if (Array.isArray(target) && key === 'length') {
        depsMap.forEach((effects, key) => {
            if (key >= newValue) {
                effects.forEach(effect => {
                    if (effect !== activeEffect) effectsToRun.add(effect)
                })
            }
        })
    }

    // 当操作类型为 add 且 目标对象是数组时，应该取出并执行那些与 length 属性相关联的副作用函数
    if (type === TriggerType.ADD && Array.isArray(target)) {
        const lengthEffects = depsMap.get('length')
        lengthEffects && lengthEffects.forEach(effect => {
            if (effect !== activeEffect) effectsToRun.add(effect)
        })
    }
    // 当操作类型为 ADD 或 DELETE 时，需要触发与 ITERATE_KEY 相关联的副作用函数重新执行
    if (type === TriggerType.ADD || type === TriggerType.DELETE) {
        // 取得与 ITERATE_KEY 相关联的副作用函数
        const iterateEffects = depsMap.get(ITERATE_KEY)
        // 将与 ITERATE_KEY 相关联的副作用函数也添加到 effectsToRun
        iterateEffects && iterateEffects.forEach(effect => {
            if (effect !== activeEffect) effectsToRun.add(effect)
        })
    }

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


const testObj = getProxyObj(
    {
        name: 'Tom',
        age: 18
    }
)

effect(() => {
    for (let prop in testObj) {
        console.log(testObj[prop])
    }
},
    // options
    {
        // // 调度器 scheduler 是一个函数
        // scheduler(fn) {
        //     // 将副作用函数放到微任务队列里执行
        //     // const p = Promise.resolve()
        //     // p.then(() => fn())

        //     // 每次调度时，将副作用函数添加到 jobQueue 队列中
        //     jobQueue.add(fn)
        //     // 调用flushJob 刷新任务队列
        //     flushJob()
        // }
    }
)

testObj.age++
testObj.age++
// testObj.add = 2
console.log(testObj)
testObj.age = 25
console.log(testObj)