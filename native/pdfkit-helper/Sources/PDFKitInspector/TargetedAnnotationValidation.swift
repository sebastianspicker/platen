import Foundation

func strictTargetedMutationRequest(from data: Data) throws -> TargetedMutationRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "mutation"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let mutation = object["mutation"] as? [String: Any],
          exactKeys(mutation, ["formFill", "annotationUpdate", "annotationRemove", "annotationProperties"]),
          exactNullableObject(mutation["formFill"], keys: ["page", "annotationIndex", "fingerprint", "fieldType", "value"]),
          exactNullableObject(mutation["annotationUpdate"], keys: ["page", "annotationIndex", "fingerprint", "subtype", "contents", "rect"]),
          exactNullableObject(mutation["annotationRemove"], keys: ["page", "annotationIndex", "fingerprint", "subtype"]),
          exactNullableObject(mutation["annotationProperties"], keys: ["page", "annotationIndex", "fingerprint", "subtype", "rect", "strokeColor"])
    else { throw InspectionFailure.invalidRequest }

    if let update = mutation["annotationUpdate"] as? [String: Any], !exactRectangle(update["rect"]) {
        throw InspectionFailure.invalidRequest
    }
    if let properties = mutation["annotationProperties"] as? [String: Any], !exactRectangle(properties["rect"]) {
        throw InspectionFailure.invalidRequest
    }
    let decoder = JSONDecoder()
    let request: TargetedMutationRequest
    do { request = try decoder.decode(TargetedMutationRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "targetedMutate",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          targetedMutationIsBounded(request.mutation)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func targetedLocatorIsBounded(page: Int, annotationIndex: Int, fingerprint: String) -> Bool {
    isWithin(page, 1, maximumPages) && isWithin(annotationIndex, 0, maximumAnnotationsPerPage - 1)
        && isLowercaseSHA256(fingerprint)
}

func validTargetedAnnotationSubtype(_ value: String) -> Bool {
    ["freeText", "square", "circle", "highlight"].contains(value)
}

func targetedMutationIsBounded(_ mutation: TargetedMutation) -> Bool {
    let categoryCount = (mutation.formFill == nil ? 0 : 1)
        + (mutation.annotationUpdate == nil ? 0 : 1) + (mutation.annotationRemove == nil ? 0 : 1)
        + (mutation.annotationProperties == nil ? 0 : 1)
    guard categoryCount == 1 else { return false }
    if let edit = mutation.formFill {
        return targetedLocatorIsBounded(page: edit.page, annotationIndex: edit.annotationIndex, fingerprint: edit.fingerprint)
            && ["text", "choice", "button"].contains(edit.fieldType)
            && (edit.fieldType == "button" ? ["on", "off", "select"].contains(edit.value) : edit.value.utf8.count <= maximumStringLength)
    }
    if let edit = mutation.annotationUpdate {
        return targetedLocatorIsBounded(page: edit.page, annotationIndex: edit.annotationIndex, fingerprint: edit.fingerprint)
            && validTargetedAnnotationSubtype(edit.subtype)
            && isWithin(edit.contents.utf8.count, 1, maximumStringLength)
            && validMutationRectangle(edit.rect)
    }
    if let edit = mutation.annotationProperties {
        return targetedLocatorIsBounded(page: edit.page, annotationIndex: edit.annotationIndex, fingerprint: edit.fingerprint)
            && edit.subtype == "square" && validMutationRectangle(edit.rect)
            && annotationPropertiesRGB(edit.strokeColor) != nil
    }
    guard let edit = mutation.annotationRemove else { return false }
    return targetedLocatorIsBounded(page: edit.page, annotationIndex: edit.annotationIndex, fingerprint: edit.fingerprint)
        && validTargetedAnnotationSubtype(edit.subtype)
}
