import Foundation
import Darwin

public func readDescriptor(_ descriptor: Int32, limit: Int) throws -> Data {
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count == 0 { return output }
        if count < 0 { throw PluginWorkerError("PLUGIN_DESCRIPTOR_READ_FAILED") }
        output.append(buffer, count: Int(count))
        if output.count > limit { throw PluginWorkerError("PLUGIN_DESCRIPTOR_TOO_LARGE") }
    }
}

public func writeDescriptor(_ descriptor: Int32, data: Data) throws {
    try data.withUnsafeBytes { rawBuffer in
        var offset = 0
        while offset < rawBuffer.count {
            let count = Darwin.write(descriptor, rawBuffer.baseAddress!.advanced(by: offset), rawBuffer.count - offset)
            if count <= 0 { throw PluginWorkerError("PLUGIN_DESCRIPTOR_WRITE_FAILED") }
            offset += Int(count)
        }
    }
}

public func readFrameDescriptor(_ descriptor: Int32) throws -> Data {
    let header = try readExact(descriptor, count: 4)
    let length = header.withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
    guard length > 0, length <= 65_536 else { throw PluginWorkerError("PLUGIN_FRAME_INVALID") }
    return try readExact(descriptor, count: Int(length))
}

public func readExact(_ descriptor: Int32, count: Int) throws -> Data {
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: count)
    while output.count < count {
        let received = Darwin.read(descriptor, &buffer, count - output.count)
        guard received > 0 else { throw PluginWorkerError("PLUGIN_DESCRIPTOR_READ_FAILED") }
        output.append(buffer, count: Int(received))
    }
    return output
}

public func closeDescriptor(_ descriptor: Int32) {
    _ = Darwin.close(descriptor)
}
