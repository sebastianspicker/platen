import Foundation
import Darwin
import PluginWorkerCore

private func workerURL() throws -> URL {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let worker = executable.deletingLastPathComponent().appendingPathComponent("PDFPluginWorker")
    guard FileManager.default.isExecutableFile(atPath: worker.path) else { throw PluginWorkerError("PLUGIN_WORKER_UNAVAILABLE") }
    return worker
}

private func selfTest() throws {
    let process = Process()
    process.executableURL = try workerURL()
    process.arguments = ["--self-test"]
    process.environment = [:]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0,
          let data = try output.fileHandleForReading.readToEnd(), data == Data("PLUGIN_WORKER_SELF_TEST_OK\n".utf8) else {
        throw PluginWorkerError("PLUGIN_SELF_TEST_FAILED")
    }
    FileHandle.standardOutput.write(data)
}

private func supervise(_ preparation: Preparation) throws {
    let sourcePipe = Pipe()
    let controlPipe = Pipe()
    let resultPipe = Pipe()
    let limitsPipe = Pipe()
    let worker = try workerURL()
    let process = Process()
    process.executableURL = worker
    let documentRequest = Pipe()
    let documentResponse = Pipe()
    process.arguments = ["--plugin-fd", "10", "--control-fd", "11", "--result-fd", "12", "--document-request-fd", "13", "--document-response-fd", "14", "--attestation-fd", "15"]
    process.environment = [:]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try inherit(sourcePipe.fileHandleForReading, as: 10)
    try inherit(controlPipe.fileHandleForReading, as: 11)
    try inherit(resultPipe.fileHandleForWriting, as: 12)
    try inherit(documentRequest.fileHandleForWriting, as: 13)
    try inherit(documentResponse.fileHandleForReading, as: 14)
    try inherit(limitsPipe.fileHandleForWriting, as: 15)
    try process.run()
    var workerFinished = false
    defer { if !workerFinished { terminateAndReap(process) } }
    for descriptor in 10...15 { closeDescriptor(Int32(descriptor)) }
    sourcePipe.fileHandleForReading.closeFile()
    controlPipe.fileHandleForReading.closeFile()
    resultPipe.fileHandleForWriting.closeFile()
    documentRequest.fileHandleForWriting.closeFile()
    documentResponse.fileHandleForReading.closeFile()
    limitsPipe.fileHandleForWriting.closeFile()
    guard fcntl(3, F_GETFD) != -1, fcntl(4, F_GETFD) != -1 else {
        throw PluginWorkerError("PLUGIN_DOCUMENT_RPC_UNAVAILABLE")
    }
    do {
        let supervisor = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let signing = try SigningValidation.attest(supervisor: supervisor, worker: worker, workerPID: process.processIdentifier)
        let limits = try decodeResourceLimitEvidence(readFrameDescriptor(limitsPipe.fileHandleForReading.fileDescriptor))
        guard limits.hardMemoryQuota, limits.processQuota else { throw PluginWorkerError("PLUGIN_RLIMIT_FAILED") }
        limitsPipe.fileHandleForReading.closeFile()
        FileHandle.standardOutput.write(try readyAttestation(preparation, signing: signing, supervisorPID: getpid(), workerPID: process.processIdentifier, limits: limits))
    } catch {
        throw error
    }
    let invocation: Invocation
    invocation = try InvocationPhase.read(prepared: preparation).invocation
    try sourcePipe.fileHandleForWriting.write(contentsOf: preparation.source)
    sourcePipe.fileHandleForWriting.closeFile()
    try controlPipe.fileHandleForWriting.write(contentsOf: invocation.controlFrame())
    controlPipe.fileHandleForWriting.closeFile()
    // FDs 3 and 4 are host-owned inherited RPC pipes. The host runs the existing
    // bounded RPC transport; this bridge relays only byte-framed envelopes.
    DispatchQueue.global().async {
        while let request = try? readFrameDescriptor(documentRequest.fileHandleForReading.fileDescriptor) {
            guard let requestValue = try? JSONValue.parse(request), let requestFrame = try? frame(requestValue),
                  (try? writeDescriptor(3, data: requestFrame)) != nil, let hostResponse = try? readFrameDescriptor(4),
                  let responseValue = try? JSONValue.parse(hostResponse), let responseFrame = try? frame(responseValue) else { break }
            try? writeDescriptor(documentResponse.fileHandleForWriting.fileDescriptor, data: responseFrame)
        }
    }
    let response = try resultPipe.fileHandleForReading.readToEnd() ?? Data()
    resultPipe.fileHandleForReading.closeFile()
    process.waitUntilExit()
    workerFinished = true
    guard process.terminationStatus == 0 else { throw PluginWorkerError("PLUGIN_WORKER_FAILED") }
    let payload = try unframe(response)
    _ = try JSONValue.parse(payload)
    FileHandle.standardOutput.write(response)
}

private func inherit(_ handle: FileHandle, as descriptor: Int32) throws {
    let source = handle.fileDescriptor
    guard dup2(source, descriptor) == descriptor else { throw PluginWorkerError("PLUGIN_PIPE_SETUP_FAILED") }
}

do {
    if CommandLine.arguments.dropFirst().elementsEqual(["--self-test-worker"]) { try selfTest() }
    else if CommandLine.arguments.count == 1 { try supervise(Preparation.read()) }
    else { throw PluginWorkerError("PLUGIN_SUPERVISOR_ARGUMENTS_INVALID") }
} catch let error as PluginWorkerError {
    FileHandle.standardError.write(Data("\(error.code)\n".utf8))
    exit(2)
} catch {
    FileHandle.standardError.write(Data("PLUGIN_SUPERVISOR_FAILED\n".utf8))
    exit(2)
}
