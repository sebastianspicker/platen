import Foundation
import Darwin

public struct ResourceLimitEvidence {
    public let cpuQuota: Bool
    public let hardMemoryQuota: Bool
    public let processQuota: Bool
    public let outputQuota: Bool
}

public struct ResourceLimits {
    public static func apply() throws -> ResourceLimitEvidence {
        try setAndVerify(RLIMIT_CPU, soft: 2, hard: 2)
        let memory = setIfSupported(RLIMIT_AS, soft: 4_096 * 1024 * 1024, hard: 4_096 * 1024 * 1024)
        try setAndVerify(RLIMIT_FSIZE, soft: 2 * 1024 * 1024, hard: 2 * 1024 * 1024)
        try setAndVerify(RLIMIT_NOFILE, soft: 32, hard: 32)
        let process = setIfSupported(RLIMIT_NPROC, soft: 1, hard: 1)
        try setAndVerify(RLIMIT_CORE, soft: 0, hard: 0)
        return ResourceLimitEvidence(cpuQuota: true, hardMemoryQuota: memory, processQuota: process, outputQuota: true)
    }

    private static func setAndVerify(_ resource: Int32, soft: rlim_t, hard: rlim_t) throws {
        var limits = rlimit(rlim_cur: soft, rlim_max: hard)
        guard setrlimit(resource, &limits) == 0 else { throw PluginWorkerError("PLUGIN_RLIMIT_FAILED") }
        var observed = rlimit(rlim_cur: 0, rlim_max: 0)
        guard getrlimit(resource, &observed) == 0,
              observed.rlim_cur == soft, observed.rlim_max == hard else { throw PluginWorkerError("PLUGIN_RLIMIT_FAILED") }
    }

    private static func setIfSupported(_ resource: Int32, soft: rlim_t, hard: rlim_t) -> Bool {
        var limits = rlimit(rlim_cur: soft, rlim_max: hard)
        guard setrlimit(resource, &limits) == 0 else { return false }
        var observed = rlimit(rlim_cur: 0, rlim_max: 0)
        return getrlimit(resource, &observed) == 0 && observed.rlim_cur == soft && observed.rlim_max == hard
    }
}

public func encodeResourceLimitEvidence(_ evidence: ResourceLimitEvidence) throws -> Data {
    try frame(.object(["cpuQuota": .bool(evidence.cpuQuota), "hardMemoryQuota": .bool(evidence.hardMemoryQuota), "outputQuota": .bool(evidence.outputQuota), "processQuota": .bool(evidence.processQuota), "protocol": .number(1), "type": .string("workerLimits")]))
}

public func decodeResourceLimitEvidence(_ data: Data) throws -> ResourceLimitEvidence {
    guard case let .object(fields) = try JSONValue.parse(data), Set(fields.keys) == ["cpuQuota", "hardMemoryQuota", "outputQuota", "processQuota", "protocol", "type"],
          case .bool(let cpu) = fields["cpuQuota"], case .bool(let memory) = fields["hardMemoryQuota"],
          case .bool(let process) = fields["processQuota"], case .bool(let output) = fields["outputQuota"],
          case .number(1) = fields["protocol"], case .string("workerLimits") = fields["type"] else { throw PluginWorkerError("PLUGIN_RLIMIT_ATTESTATION_INVALID") }
    return ResourceLimitEvidence(cpuQuota: cpu, hardMemoryQuota: memory, processQuota: process, outputQuota: output)
}
