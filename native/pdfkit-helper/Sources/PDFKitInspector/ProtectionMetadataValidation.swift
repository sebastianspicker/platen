import Foundation

func strictProtectionRequest(from data: Data) throws -> ProtectionRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "protection"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let protection = object["protection"] as? [String: Any],
          exactKeys(protection, ["profile", "ownerPassword", "userPassword"])
    else { throw InspectionFailure.invalidRequest }

    let decoder = JSONDecoder()
    let request: ProtectionRequest
    do { request = try decoder.decode(ProtectionRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "protect",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          ["accessibility-only", "copy-accessibility", "deny-all", "print-only"].contains(request.protection.profile),
          visibleASCIIPassword(request.protection.ownerPassword, maximumLength: 32),
          visibleASCIIPassword(request.protection.userPassword, maximumLength: 16),
          request.protection.ownerPassword != request.protection.userPassword
    else { throw InspectionFailure.invalidRequest }
    return request
}

func strictProtectionRemovalRequest(from data: Data) throws -> ProtectionRemovalRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, [
              "version", "operation", "inputFilename", "outputFilename", "sourceSha256",
              "limits", "removal",
          ]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, [
              "maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage",
              "maxOutlineDepth", "maxOutlineItems",
          ]),
          let removal = object["removal"] as? [String: Any],
          exactKeys(removal, ["sourceProfile", "ownerPassword"])
    else { throw InspectionFailure.invalidRequest }

    let decoder = JSONDecoder()
    let request: ProtectionRemovalRequest
    do { request = try decoder.decode(ProtectionRemovalRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "removeProtection",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          ["accessibility-only", "copy-accessibility", "deny-all", "print-only"].contains(request.removal.sourceProfile),
          visibleASCIIPassword(request.removal.ownerPassword, maximumLength: 32)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func strictMetadataSanitizationRequest(from data: Data) throws -> MetadataSanitizationRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"])
    else { throw InspectionFailure.invalidRequest }
    let request: MetadataSanitizationRequest
    do { request = try JSONDecoder().decode(MetadataSanitizationRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }
    guard request.version == protocolVersion, request.operation == "sanitizeMetadata",
          request.inputFilename == mutationInputFilename, request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func visibleASCIIPassword(_ value: String, maximumLength: Int) -> Bool {
    let bytes = Array(value.utf8)
    return isWithin(bytes.count, 12, maximumLength)
        && bytes.first != 0x20 && bytes.last != 0x20
        && bytes.allSatisfy { byte in byte >= 0x20 && byte <= 0x7e }
}
