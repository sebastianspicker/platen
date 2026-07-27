import Foundation

func strictLocalGoToRequest(from data: Data) throws -> LocalGoToRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "link"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let link = object["link"] as? [String: Any],
          exactKeys(link, ["sourcePage", "targetPage", "rect"]),
          exactRectangle(link["rect"])
    else { throw InspectionFailure.invalidRequest }

    let decoder = JSONDecoder()
    let request: LocalGoToRequest
    do { request = try decoder.decode(LocalGoToRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "addLocalGoToLink",
          request.inputFilename == mutationInputFilename,
          request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 1, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          validMutationPage(request.link.sourcePage),
          validMutationPage(request.link.targetPage),
          validMutationRectangle(request.link.rect)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func strictLocalGoToRemovalRequest(from data: Data) throws -> LocalGoToRemovalRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "link"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let link = object["link"] as? [String: Any],
          exactKeys(link, ["page", "annotationIndex", "fingerprint"]),
          exactInteger(link["page"]), exactInteger(link["annotationIndex"]), link["fingerprint"] is String
    else { throw InspectionFailure.invalidRequest }
    let decoder = JSONDecoder()
    let request: LocalGoToRemovalRequest
    do { request = try decoder.decode(LocalGoToRemovalRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }
    guard request.version == protocolVersion, request.operation == "removeLocalGoToLink",
          request.inputFilename == mutationInputFilename, request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256), isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 1, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems),
          validMutationPage(request.link.page),
          isWithin(request.link.annotationIndex, 0, maximumAnnotationsPerPage - 1),
          isLowercaseSHA256(request.link.fingerprint)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func strictOutlineBookmarkRequest(from data: Data) throws -> OutlineBookmarkRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "bookmark"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let bookmark = object["bookmark"] as? [String: Any], exactKeys(bookmark, ["page", "label"]),
          exactInteger(bookmark["page"]), bookmark["label"] is String
    else { throw InspectionFailure.invalidRequest }
    let decoder = JSONDecoder()
    let request: OutlineBookmarkRequest
    do { request = try decoder.decode(OutlineBookmarkRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }
    guard request.version == protocolVersion, request.operation == "appendOutlineBookmark",
          request.inputFilename == mutationInputFilename, request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256), isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 1, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 1, maximumOutlineItems),
          validMutationPage(request.bookmark.page), validOutlineBookmarkLabel(request.bookmark.label)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func strictOutlineBookmarkRemovalRequest(from data: Data) throws -> OutlineBookmarkRemovalRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "bookmark"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let bookmark = object["bookmark"] as? [String: Any],
          exactKeys(bookmark, ["topLevelIndex", "fingerprint"]),
          exactInteger(bookmark["topLevelIndex"]), bookmark["fingerprint"] is String
    else { throw InspectionFailure.invalidRequest }
    let decoder = JSONDecoder()
    let request: OutlineBookmarkRemovalRequest
    do { request = try decoder.decode(OutlineBookmarkRemovalRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }
    guard request.version == protocolVersion, request.operation == "removeOutlineBookmark",
          request.inputFilename == mutationInputFilename, request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256), isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 1, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 1, maximumOutlineItems),
          isWithin(request.bookmark.topLevelIndex, 0, maximumOutlineItems - 1),
          isLowercaseSHA256(request.bookmark.fingerprint)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func strictOutlineBookmarkRenameRequest(from data: Data) throws -> OutlineBookmarkRenameRequest {
    guard data.count <= maxRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(object, ["version", "operation", "inputFilename", "outputFilename", "sourceSha256", "limits", "bookmarkRename"]),
          let limits = object["limits"] as? [String: Any],
          exactKeys(limits, ["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"]),
          let rename = object["bookmarkRename"] as? [String: Any],
          exactKeys(rename, ["topLevelIndex", "fingerprint", "label"]),
          exactInteger(rename["topLevelIndex"]), rename["fingerprint"] is String, rename["label"] is String
    else { throw InspectionFailure.invalidRequest }
    let decoder = JSONDecoder()
    let request: OutlineBookmarkRenameRequest
    do { request = try decoder.decode(OutlineBookmarkRenameRequest.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }
    guard request.version == protocolVersion, request.operation == "renameOutlineBookmark",
          request.inputFilename == mutationInputFilename, request.outputFilename == mutationOutputFilename,
          isLowercaseSHA256(request.sourceSha256), isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 1, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 1, maximumOutlineItems),
          isWithin(request.bookmarkRename.topLevelIndex, 0, maximumOutlineItems - 1),
          isLowercaseSHA256(request.bookmarkRename.fingerprint), validOutlineBookmarkLabel(request.bookmarkRename.label)
    else { throw InspectionFailure.invalidRequest }
    return request
}

func validOutlineBookmarkLabel(_ label: String) -> Bool {
    let normalized = NSMutableString(string: label)
    CFStringNormalize(normalized, CFStringNormalizationForm.C)
    guard isWithin(label.utf8.count, 1, maximumStringLength),
          label.utf8.elementsEqual((normalized as String).utf8),
          label == label.trimmingCharacters(in: .whitespacesAndNewlines)
    else { return false }
    return label.unicodeScalars.allSatisfy { scalar in
        let value = scalar.value
        return scalar.properties.generalCategory != .control && scalar.properties.generalCategory != .format
            && value != 0x2028 && value != 0x2029
    }
}
