import Foundation
import PluginWorkerCore

var activeInvocation: Invocation?

func workerDescriptors() throws -> (Int32, Int32, Int32, Int32, Int32, Int32) {
    let arguments = CommandLine.arguments.dropFirst()
    guard arguments.count == 12,
          Array(arguments.enumerated()).allSatisfy({ index, value in index % 2 == 0 ? ["--plugin-fd", "--control-fd", "--result-fd", "--document-request-fd", "--document-response-fd", "--attestation-fd"].contains(value) : Int32(value) != nil }),
          arguments[0] == "--plugin-fd", arguments[2] == "--control-fd", arguments[4] == "--result-fd", arguments[6] == "--document-request-fd", arguments[8] == "--document-response-fd", arguments[10] == "--attestation-fd",
          let source = Int32(arguments[1]), let control = Int32(arguments[3]), let result = Int32(arguments[5]), let request = Int32(arguments[7]), let response = Int32(arguments[9]), let attestation = Int32(arguments[11]),
          source >= 3, control >= 3, result >= 3, request >= 3, response >= 3, attestation >= 3, Set([source, control, result, request, response, attestation]).count == 6 else {
        throw PluginWorkerError("PLUGIN_WORKER_ARGUMENTS_INVALID")
    }
    return (source, control, result, request, response, attestation)
}

do {
    if CommandLine.arguments.dropFirst().elementsEqual(["--self-test"]) {
        let limits = try ResourceLimits.apply()
        guard limits.hardMemoryQuota else { throw PluginWorkerError("PLUGIN_RLIMIT_FAILED") }
        let source = Data("registerPlugin({invoke: (input) => ({accepted: input.accepted})});".utf8)
        let plugin = try JavaScriptPlugin(source: source)
        let output = try plugin.invoke(.object(["accepted": .bool(true)]))
        guard output == .object(["accepted": .bool(true)]) else { throw PluginWorkerError("PLUGIN_SELF_TEST_FAILED") }
        FileHandle.standardOutput.write(Data("PLUGIN_WORKER_SELF_TEST_OK\n".utf8))
        exit(0)
    }
    let (sourceDescriptor, controlDescriptor, resultDescriptor, requestDescriptor, responseDescriptor, attestationDescriptor) = try workerDescriptors()
    let limits = try ResourceLimits.apply()
    try writeDescriptor(attestationDescriptor, data: try encodeResourceLimitEvidence(limits))
    closeDescriptor(attestationDescriptor)
    let source = try readDescriptor(sourceDescriptor, limit: 1_048_576)
    closeDescriptor(sourceDescriptor)
    let control = try unframe(readDescriptor(controlDescriptor, limit: 65_540))
    closeDescriptor(controlDescriptor)
    let invocation = try Invocation.decodeControl(control)
    activeInvocation = invocation
    let plugin = try JavaScriptPlugin(source: source, documentRPC: DocumentRPC(invocation: invocation, requestDescriptor: requestDescriptor, responseDescriptor: responseDescriptor))
    let output = try completion(invocation, result: try plugin.invoke(invocation.input))
    try writeDescriptor(resultDescriptor, data: output)
    closeDescriptor(resultDescriptor)
} catch let error as PluginWorkerError {
    if let invocation = activeInvocation, let descriptor = try? workerDescriptors().2, let output = try? failure(invocation) { try? writeDescriptor(descriptor, data: output) }
    FileHandle.standardError.write(Data("\(error.code)\n".utf8))
    exit(2)
} catch {
    FileHandle.standardError.write(Data("PLUGIN_WORKER_FAILED\n".utf8))
    exit(2)
}
