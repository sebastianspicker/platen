import Foundation

func strictMutationRequest(from data: Data) throws -> MutationRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "mutation"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let mutation = object["mutation"] as? [String: Any],
          exactKeys(mutation, ["metadata", "pageBox", "annotations", "rotation"])
    else { throw InspectionFailure.invalidRequest }

    if let metadata = mutation["metadata"] as? [String: Any],
       !exactKeys(metadata, ["title", "author", "subject", "keywords"]) {
        throw InspectionFailure.invalidRequest
    }
    if let pageBox = mutation["pageBox"] as? [String: Any],
       (!exactKeys(pageBox, ["page", "box", "rect"]) || !exactRectangle(pageBox["rect"])) {
        throw InspectionFailure.invalidRequest
    }
    guard exactNullableObject(mutation["rotation"], keys: ["page", "degrees"]) else {
        throw InspectionFailure.invalidRequest
    }
    if let rotation = mutation["rotation"] as? [String: Any],
       (!exactInteger(rotation["page"]) || !exactInteger(rotation["degrees"])) {
        throw InspectionFailure.invalidRequest
    }
    guard let annotations = mutation["annotations"] as? [[String: Any]] else { throw InspectionFailure.invalidRequest }
    for annotation in annotations {
        guard exactKeys(annotation, ["page", "subtype", "contents", "rect"]), exactRectangle(annotation["rect"]) else {
            throw InspectionFailure.invalidRequest
        }
    }
    let decoder = JSONDecoder()
    let request: MutationRequest
    do { request = try decoder.decode(MutationRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "mutate",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          request.sourceSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          mutationIsBounded(request.mutation)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func mutationIsBounded(_ mutation: Mutation) -> Bool {
    guard mutation.annotations.count <= 1 else { return false }
    if let metadata = mutation.metadata,
       [metadata.title, metadata.author, metadata.subject, metadata.keywords].contains(where: { value in
           value.map { $0.utf8.count > maximumStringLength } ?? false
       }) { return false }
    if let pageBox = mutation.pageBox,
       !validMutationPage(pageBox.page) || !validBox(pageBox.box) || !validMutationRectangle(pageBox.rect) { return false }
    if let rotation = mutation.rotation,
       (!validMutationPage(rotation.page) || !validPageRotation(rotation.degrees)) { return false }
    for annotation in mutation.annotations {
        guard validMutationPage(annotation.page), validAnnotationSubtype(annotation.subtype),
              annotation.contents.utf8.count <= maximumStringLength, validMutationRectangle(annotation.rect)
        else { return false }
    }
    let count = requestedEditCount(mutation)
    return isWithin(count, 1, maximumMutationEdits)
}

func validMutationPage(_ page: Int) -> Bool { isWithin(page, 1, maximumPages) }

func validPageRotation(_ degrees: Int) -> Bool { [0, 90, 180, 270].contains(degrees) }

func validBox(_ value: String) -> Bool { ["media", "crop", "bleed", "trim", "art"].contains(value) }

func validAnnotationSubtype(_ value: String) -> Bool {
    ["text", "freeText", "square", "circle", "highlight", "underline"].contains(value)
}

func validMutationRectangle(_ value: MutationRectangle) -> Bool {
    [value.x, value.y, value.width, value.height].allSatisfy { $0.isFinite && abs($0) <= maximumCoordinate }
        && value.width > 0 && value.height > 0
}

func requestedEditCount(_ mutation: Mutation) -> Int {
    let categories = (mutation.metadata == nil ? 0 : 1) + (mutation.pageBox == nil ? 0 : 1)
        + (mutation.annotations.isEmpty ? 0 : 1) + (mutation.rotation == nil ? 0 : 1)
    guard categories == 1 else { return 0 }
    return mutation.metadata == nil ? 1 : 4
}
