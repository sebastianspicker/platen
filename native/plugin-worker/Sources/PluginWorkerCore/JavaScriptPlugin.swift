import Foundation
import JavaScriptCore

public final class JavaScriptPlugin {
    private let context: JSContext
    private var invocation: JSValue?
    private var registrations = 0

    public init(source: Data, documentRPC: DocumentRPC? = nil) throws {
        let script = try ScriptPolicy.validate(source)
        guard let context = JSContext() else { throw PluginWorkerError("PLUGIN_CONTEXT_UNAVAILABLE") }
        self.context = context
        context.exceptionHandler = { _, _ in }
        removeDynamicCodeSurface(context)
        let register: @convention(block) (JSValue) -> Void = { [weak self] value in self?.register(value) }
        context.setObject(register, forKeyedSubscript: "registerPlugin" as NSString)
        documentRPC?.install(in: context)
        _ = context.evaluateScript(script)
        guard context.exception == nil, registrations == 1, invocation != nil else { throw PluginWorkerError("PLUGIN_REGISTER_INVALID") }
    }

    public func invoke(_ input: JSONValue) throws -> JSONValue {
        guard let invocation else { throw PluginWorkerError("PLUGIN_REGISTER_INVALID") }
        let argument = JSValue(object: input.foundationValue, in: context)
        let result = invocation.call(withArguments: [argument as Any])
        guard context.exception == nil, let result, !result.isUndefined, !result.isNull,
              let value = result.toObject() else { throw PluginWorkerError("PLUGIN_INVOKE_FAILED") }
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        return try JSONValue.parse(data)
    }

    private func register(_ value: JSValue) {
        registrations += 1
        guard registrations == 1, value.isObject,
              let candidate = value.forProperty("invoke"), candidate.isObject else { return }
        invocation = candidate
    }
}

private func removeDynamicCodeSurface(_ context: JSContext) {
    context.setObject(nil, forKeyedSubscript: "eval" as NSString)
    context.setObject(nil, forKeyedSubscript: "Function" as NSString)
    context.setObject(nil, forKeyedSubscript: "WebAssembly" as NSString)
    _ = context.evaluateScript("'use strict'; Object.freeze(Object.prototype); Object.freeze(Function.prototype);")
}
