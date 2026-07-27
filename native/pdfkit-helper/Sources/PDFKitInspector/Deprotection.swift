import Foundation
import PDFKit
import CoreGraphics

private struct DeprotectionOutlineNode {
    let label: String
    let isOpen: Bool
    let pageIndex: Int
    let point: CGPoint
    let zoom: CGFloat
    let usesGoToAction: Bool
    let children: [DeprotectionOutlineNode]
}

private func removalDestinationValueIsSafe(_ value: CGFloat) -> Bool {
    let number = Double(value)
    let unspecified = Double(Float.greatestFiniteMagnitude)
    return number.isFinite && (abs(number) <= maximumCoordinate || number == unspecified)
}

private func removalCatalogIsStrict(_ document: PDFDocument, allowingVersion: Bool) -> Bool {
    guard let catalog = document.documentRef?.catalog,
          pdfName(catalog, key: "Type") == "Catalog",
          dictionaryContainsOnlyKeys(
              catalog,
              allowed: allowingVersion ? ["Type", "Pages", "Outlines", "Version"] : ["Type", "Pages", "Outlines"]
          )
    else { return false }
    var pages: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "Pages", &pages), pages != nil else { return false }
    if dictionaryContainsObject(catalog, key: "Outlines") {
        var outlines: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(catalog, "Outlines", &outlines), outlines != nil else { return false }
    }
    return !dictionaryContainsObject(catalog, key: "Version")
        || allowingVersion && pdfName(catalog, key: "Version") != nil
}

private func removalPagesArePassive(_ document: PDFDocument, limits: Limits) -> Bool {
    guard isWithin(document.pageCount, 1, limits.maxPages), let documentRef = document.documentRef else { return false }
    for pageNumber in 1...document.pageCount {
        guard let page = document.page(at: pageNumber - 1),
              page.annotations.count <= limits.maxAnnotationsPerPage,
              let dictionary = documentRef.page(at: pageNumber)?.dictionary,
              pdfName(dictionary, key: "Type") == "Page",
              !["A", "AA", "OpenAction", "AF", "PresSteps", "Dur", "Trans", "StructParents"].contains(where: {
                  dictionaryContainsObject(dictionary, key: $0)
              })
        else { return false }
    }
    return true
}

private func removalStableAttributes(_ document: PDFDocument) -> [PDFDocumentAttribute: Any]? {
    let stable = protectionStableMetadata(document)
    let values = [stable.title, stable.author, stable.subject, stable.creator, stable.keywords]
    guard values.compactMap({ $0 }).allSatisfy({ $0.utf8.count <= maximumStringLength }) else { return nil }
    var attributes: [PDFDocumentAttribute: Any] = [:]
    if let title = stable.title { attributes[.titleAttribute] = title }
    if let author = stable.author { attributes[.authorAttribute] = author }
    if let subject = stable.subject { attributes[.subjectAttribute] = subject }
    if let creator = stable.creator { attributes[.creatorAttribute] = creator }
    if let keywords = stable.keywords { attributes[.keywordsAttribute] = [keywords] }
    return attributes
}

private func removalOutlineBlueprint(
    _ document: PDFDocument,
    limits: Limits
) -> [DeprotectionOutlineNode]? {
    guard let policies = rawOutlinePolicies(document, limits: limits) else { return nil }
    guard let root = document.outlineRoot else { return policies.isEmpty ? [] : nil }
    var itemCount = 0
    func children(of parent: PDFOutline, depth: Int, prefix: String) -> [DeprotectionOutlineNode]? {
        guard depth < limits.maxOutlineDepth || parent.numberOfChildren == 0 else { return nil }
        var result: [DeprotectionOutlineNode] = []
        result.reserveCapacity(parent.numberOfChildren)
        for index in 0..<parent.numberOfChildren {
            guard itemCount < limits.maxOutlineItems, let item = parent.child(at: index) else { return nil }
            itemCount += 1
            let path = prefix.isEmpty ? String(index) : "\(prefix).\(index)"
            guard let policy = policies[path], let label = item.label, label == policy.title,
                  isWithin(label.utf8.count, 1, maximumStringLength)
            else { return nil }
            let destination: PDFDestination
            let usesGoToAction: Bool
            switch policy.action {
            case .directDestination:
                guard let direct = item.destination else { return nil }
                destination = direct
                usesGoToAction = false
            case .goToAction:
                guard let action = item.action as? PDFActionGoTo else { return nil }
                destination = action.destination
                usesGoToAction = true
            case .unsafe:
                return nil
            }
            guard let page = destination.page else { return nil }
            let pageIndex = document.index(for: page)
            let point = destination.point
            let zoom = destination.zoom
            guard pageIndex != NSNotFound, pageIndex >= 0, pageIndex < document.pageCount,
                  removalDestinationValueIsSafe(point.x), removalDestinationValueIsSafe(point.y),
                  removalDestinationValueIsSafe(zoom),
                  let nested = children(of: item, depth: depth + 1, prefix: path)
            else { return nil }
            result.append(DeprotectionOutlineNode(
                label: label, isOpen: item.isOpen, pageIndex: pageIndex, point: point, zoom: zoom,
                usesGoToAction: usesGoToAction, children: nested
            ))
        }
        return result
    }
    guard let result = children(of: root, depth: 0, prefix: "") else { return nil }
    guard itemCount == policies.count else { return nil }
    return result
}

private func installRemovalOutline(_ nodes: [DeprotectionOutlineNode], in document: PDFDocument) -> Bool {
    guard !nodes.isEmpty else { return true }
    let root = PDFOutline()
    func append(_ entries: [DeprotectionOutlineNode], to parent: PDFOutline) -> Bool {
        for entry in entries {
            guard let page = document.page(at: entry.pageIndex) else { return false }
            let destination = PDFDestination(page: page, at: entry.point)
            destination.zoom = entry.zoom
            let item = PDFOutline()
            item.label = entry.label
            item.isOpen = entry.isOpen
            if entry.usesGoToAction {
                item.action = PDFActionGoTo(destination: destination)
            } else {
                item.destination = destination
            }
            guard append(entry.children, to: item) else { return false }
            parent.insertChild(item, at: parent.numberOfChildren)
        }
        return true
    }
    guard append(nodes, to: root) else { return false }
    document.outlineRoot = root
    return true
}

func removeProtection(
    _ request: ProtectionRemovalRequest,
    workspace: URL,
    inputData: Data
) throws -> ProtectionRemovalReceipt {
    let sourceSha256 = sha256Hex(inputData)
    guard request.sourceSha256 == sourceSha256,
          let sourceProfile = protectionPermissionProfile(named: request.removal.sourceProfile),
          usesExpectedAES128Encryption(inputData, profile: sourceProfile),
          let source = PDFDocument(data: inputData), source.isEncrypted, source.isLocked,
          source.unlock(withPassword: request.removal.ownerPassword), !source.isLocked,
          source.permissionsStatus == .owner
    else { throw InspectionFailure.mutationFailed }

    guard removalCatalogIsStrict(source, allowingVersion: true),
          removalPagesArePassive(source, limits: request.limits),
          !documentHasActionsOrSignatureWidgets(source), !rawPagesContainActions(source),
          let inputDescriptors = passiveAnnotationDescriptors(source, limits: request.limits),
          let outline = removalOutlineBlueprint(source, limits: request.limits),
          let attributes = removalStableAttributes(source),
          let inputStructure = protectionStructure(source, limits: request.limits),
          let inputPostflight = protectionPostflightSnapshot(source, limits: request.limits),
          inputPostflight.annotationDescriptors == inputDescriptors
    else { throw InspectionFailure.mutationFailed }

    let target = PDFDocument()
    for pageIndex in 0..<source.pageCount {
        guard let sourcePage = source.page(at: pageIndex), let copy = sourcePage.copy() as? PDFPage else {
            throw InspectionFailure.mutationFailed
        }
        target.insert(copy, at: pageIndex)
    }
    target.documentAttributes = attributes
    guard installRemovalOutline(outline, in: target),
          let outputData = target.dataRepresentation(), outputData.count <= maxOutputBytes,
          outputData != inputData
    else { throw InspectionFailure.mutationFailed }

    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let unchangedInput = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
    let reopenedData = try readPrivateInput(output)
    guard unchangedInput == inputData, reopenedData == outputData,
          let reopened = PDFDocument(data: reopenedData),
          !reopened.isEncrypted, !reopened.isLocked, reopened.permissionsStatus == .owner,
          removalCatalogIsStrict(reopened, allowingVersion: false),
          removalPagesArePassive(reopened, limits: request.limits),
          !documentHasActionsOrSignatureWidgets(reopened), !rawPagesContainActions(reopened),
          passiveAnnotationDescriptors(reopened, limits: request.limits) != nil,
          removalOutlineBlueprint(reopened, limits: request.limits) != nil,
          let outputStructure = protectionStructure(reopened, limits: request.limits),
          outputStructure == inputStructure,
          let outputPostflight = protectionPostflightSnapshot(reopened, limits: request.limits),
          outputPostflight == inputPostflight
    else { throw InspectionFailure.outputInvalid }

    return ProtectionRemovalReceipt(
        sourceSha256: sourceSha256,
        outputSha256: sha256Hex(reopenedData),
        sourceProfile: request.removal.sourceProfile,
        pageCount: reopened.pageCount,
        structuralSummary: outputStructure
    )
}
