import Foundation

private func canonicalNFC(_ value: String) -> String {
    let normalized = NSMutableString(string: value)
    CFStringNormalize(normalized, CFStringNormalizationForm.C)
    return normalized as String
}

private func validCanonicalText(_ value: String, maximumBytes: Int, allowEmpty: Bool) -> Bool {
    let normalized = canonicalNFC(value)
    guard (allowEmpty ? value.utf8.count <= maximumBytes : isWithin(value.utf8.count, 1, maximumBytes)),
          value.utf8.elementsEqual(normalized.utf8),
          value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    else { return false }
    return value.unicodeScalars.allSatisfy { scalar in
        let category = scalar.properties.generalCategory
        let value = scalar.value
        return category != .control && category != .format && value != 0x2028 && value != 0x2029
    }
}

private func validTextFieldName(_ value: String) -> Bool {
    guard validCanonicalText(value, maximumBytes: 64, allowEmpty: false) else { return false }
    let scalars = Array(value.unicodeScalars)
    guard let first = scalars.first,
          (first.value >= 0x41 && first.value <= 0x5a) || (first.value >= 0x61 && first.value <= 0x7a)
    else { return false }
    return scalars.dropFirst().allSatisfy { scalar in
        (scalar.value >= 0x41 && scalar.value <= 0x5a)
            || (scalar.value >= 0x61 && scalar.value <= 0x7a)
            || (scalar.value >= 0x30 && scalar.value <= 0x39)
            || scalar.value == 0x2d || scalar.value == 0x2e || scalar.value == 0x5f
    }
}

func strictTextFieldWidgetRequest(from data: Data) throws -> TextFieldWidgetRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "field"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let field = object["field"] as? [String: Any],
          (exactKeys(field, ["page", "rect", "name"]) || exactKeys(field, ["page", "rect", "name", "defaultValue"])),
          exactInteger(field["page"]), exactRectangle(field["rect"]), field["name"] is String,
          field["defaultValue"] == nil || field["defaultValue"] is NSNull || field["defaultValue"] is String
    else { throw InspectionFailure.invalidRequest }

    let decoder = JSONDecoder()
    let request: TextFieldWidgetRequest
    do { request = try decoder.decode(TextFieldWidgetRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "addTextFieldWidget",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 1, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          validMutationPage(request.field.page),
          validMutationRectangle(request.field.rect),
          validTextFieldName(request.field.name),
          request.field.defaultValue.map({ validCanonicalText($0, maximumBytes: 256, allowEmpty: true) }) ?? true
    else { throw InspectionFailure.invalidRequest }
    return request
}
