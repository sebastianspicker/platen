import Foundation
import CryptoKit
import Darwin

public struct Preparation {
    public let pluginId: String
    public let version: String
    public let packageHash: String
    public let sourceSha256: String
    public let source: Data

    public static func read(from descriptor: Int32 = STDIN_FILENO) throws -> Preparation {
        let header = try readHeader(descriptor)
        guard case let .object(fields) = header, Set(fields.keys) == ["packageHash", "pluginId", "sourceBytes", "sourceSha256", "version"],
              case let .string(pluginId) = fields["pluginId"], case let .string(version) = fields["version"],
              case let .string(packageHash) = fields["packageHash"], case let .string(sourceSha256) = fields["sourceSha256"],
              case let .number(sourceBytes) = fields["sourceBytes"], sourceBytes.rounded() == sourceBytes, sourceBytes > 0, sourceBytes <= 1_048_576,
              validPluginId(pluginId), validSemver(version), validHex(packageHash), validHex(sourceSha256) else { throw PluginWorkerError("PLUGIN_PREPARATION_INVALID") }
        let source = try readExact(descriptor, count: Int(sourceBytes))
        guard SHA256.hash(data: source).hex == sourceSha256 else { throw PluginWorkerError("PLUGIN_SOURCE_DIGEST_MISMATCH") }
        return Preparation(pluginId: pluginId, version: version, packageHash: packageHash, sourceSha256: sourceSha256, source: source)
    }
}

public struct InvocationPhase {
    public let invocation: Invocation

    public static func read(from descriptor: Int32 = STDIN_FILENO, prepared: Preparation) throws -> InvocationPhase {
        let header = try readHeader(descriptor)
        guard case let .object(fields) = header, Set(fields.keys) == ["controlBytes"], case let .number(size) = fields["controlBytes"],
              size.rounded() == size, size > 0, size <= 65_536 else { throw PluginWorkerError("PLUGIN_INVOCATION_PHASE_INVALID") }
        let invocation = try Invocation.decodeControl(readExact(descriptor, count: Int(size)))
        guard invocation.pluginId == prepared.pluginId, invocation.version == prepared.version, invocation.packageHash == prepared.packageHash else {
            throw PluginWorkerError("PLUGIN_INVOCATION_BINDING_MISMATCH")
        }
        return InvocationPhase(invocation: invocation)
    }
}

public func readyAttestation(_ preparation: Preparation, signing: SigningAttestation, supervisorPID: pid_t, workerPID: pid_t, limits: ResourceLimitEvidence) throws -> Data {
    try frame(.object([
        "appSandbox": .bool(true), "cpuQuota": .bool(limits.cpuQuota), "designatedRequirementSha256": .string(signing.designatedRequirementSha256),
        "hardMemoryQuota": .bool(limits.hardMemoryQuota), "liveCodeIdentity": .bool(true), "noNetwork": .bool(true),
        "outputQuota": .bool(limits.outputQuota), "packageHash": .string(preparation.packageHash), "pluginId": .string(preparation.pluginId),
        "pluginVersion": .string(preparation.version), "privateIpc": .bool(true), "processQuota": .bool(limits.processQuota),
        "protocol": .number(1), "schema": .string("pdf-plugin-native-attestation-v1"), "sourceBytesOnly": .bool(true),
        "sourceSha256": .string(preparation.sourceSha256), "staticCodeIdentity": .bool(true), "supervisorCdHash": .string(signing.supervisorCdHash),
        "supervisorPid": .number(Double(supervisorPID)), "teamIdentifier": .string(signing.teamIdentifier), "type": .string("ready"),
        "workerCdHash": .string(signing.workerCdHash), "workerPid": .number(Double(workerPID)),
    ]))
}

private func readHeader(_ descriptor: Int32) throws -> JSONValue {
    var bytes = Data()
    while bytes.count <= 65_536 {
        let byte = try readExact(descriptor, count: 1)
        if byte[0] == 10 { return try JSONValue.parse(bytes) }
        bytes.append(byte)
    }
    throw PluginWorkerError("PLUGIN_BOOTSTRAP_TOO_LARGE")
}

private func validPluginId(_ value: String) -> Bool { value.range(of: "^[a-z][a-z0-9]*(?:[.][a-z0-9-]+)+$", options: .regularExpression) != nil }
private func validSemver(_ value: String) -> Bool { value.range(of: "^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$", options: .regularExpression) != nil }
private func validHex(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }

private extension Digest {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
