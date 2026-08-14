import Foundation

func strictTrustRequest(from data: Data) throws -> TrustRequest {
    guard data.count <= maxTrustRequestBytes else { throw TrustFailure.requestTooLarge }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == Set(["version", "operation", "inputFilename", "sourceSha256", "limits", "records"]),
          let limits = object["limits"] as? [String: Any],
          Set(limits.keys) == Set([
              "maxPdfBytes", "maxSignatures",
              "maxCmsBytesPerSignature", "maxCmsBytesTotal", "maxCertificatesPerSignature", "maxCertificateBytes",
              "maxBerDepth", "maxBerNodes",
          ]),
          let records = object["records"] as? [[String: Any]],
          records.count <= fixedLimits.maxSignatures
    else { throw TrustFailure.invalidRequest }

    for (index, record) in records.enumerated() {
        guard Set(record.keys) == Set(["byteRange", "subFilter", "cmsFilename", "cmsSha256"]),
              let byteRange = record["byteRange"] as? [Any], byteRange.count == 4,
              byteRange.allSatisfy(exactNonnegativeInteger),
              record["subFilter"] is NSNull || boundedSubFilter(record["subFilter"]),
              record["cmsFilename"] as? String == "dumps/input.pdf.sig\(index)",
              let cmsSha256 = record["cmsSha256"] as? String,
              lowercaseSHA256(cmsSha256)
        else { throw TrustFailure.invalidRequest }
    }

    let request: TrustRequest
    do { request = try JSONDecoder().decode(TrustRequest.self, from: data) }
    catch { throw TrustFailure.invalidRequest }

    guard request.version == trustProtocolVersion,
          request.operation == "validateEmbeddedCertificateChains",
          request.inputFilename == "input.pdf",
          lowercaseSHA256(request.sourceSha256),
          request.limits == fixedLimits,
          request.records.count == records.count
    else { throw TrustFailure.invalidRequest }
    return request
}

private func lowercaseSHA256(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
}

private func exactNonnegativeInteger(_ value: Any) -> Bool {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return false }
    let double = number.doubleValue
    return double.isFinite && double >= 0 && double.rounded() == double && double <= Double(Int64.max)
}

private func boundedSubFilter(_ value: Any?) -> Bool {
    guard let string = value as? String else { return false }
    return string.utf8.count <= 128
}
