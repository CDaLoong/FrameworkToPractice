"use strict";
// 采用 Proxy 实现响应式系统，通过劫持对象的 getter 和 setter 来实现
// 存储副作用函数
const bucket = new WeakMap();
