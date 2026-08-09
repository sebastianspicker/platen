import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics

private func setMetadata(_ patch: MetadataPatch, document: PDFDocument) {
    var attributes = document.documentAttributes ?? [:]
    func set(_ value: String?, _ key: PDFDocumentAttribute, keyword: Bool = false) {
        if let value { attributes[key] = keyword ? [value] : value }
        else { attributes.removeValue(forKey: key) }
    }
    set(patch.title, .titleAttribute)
    set(patch.author, .authorAttribute)
    set(patch.subject, .subjectAttribute)
    set(patch.keywords, .keywordsAttribute, keyword: true)
    document.documentAttributes = attributes
}

private func applyPageBox(_ edit: PageBoxEdit, document: PDFDocument) -> Bool {
    guard let page = document.page(at: edit.page - 1), let box = displayBox(edit.box) else { return false }
    page.setBounds(cgRect(edit.rect), for: box)
    return true
}

private func annotationType(_ value: String) -> PDFAnnotationSubtype? {
    switch value {
    case "text": return .text
    case "freeText": return .freeText
    case "square": return .square
    case "circle": return .circle
    case "highlight": return .highlight
    case "underline": return .underline
    default: return nil
    }
}

private func applyAnnotation(_ edit: AnnotationEdit, document: PDFDocument) -> Bool {
    guard let page = document.page(at: edit.page - 1), let type = annotationType(edit.subtype) else { return false }
    let annotation = PDFAnnotation(bounds: cgRect(edit.rect), forType: type, withProperties: nil)
    annotation.contents = edit.contents
    page.addAnnotation(annotation)
    return true
}

func writePrivateOutput(_ data: Data, to url: URL) throws {
    guard data.count > 0, data.count <= maxOutputBytes else { throw InspectionFailure.outputWriteFailed }
    var existing = stat()
    if lstat(url.path, &existing) == 0 { throw InspectionFailure.outputExists }
    guard errno == ENOENT else { throw InspectionFailure.unsafeWorkspace }

    let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard descriptor >= 0 else {
        if errno == EEXIST { throw InspectionFailure.outputExists }
        throw InspectionFailure.outputWriteFailed
    }
    defer { close(descriptor) }
    guard fchmod(descriptor, mode_t(0o600)) == 0 else { throw InspectionFailure.outputWriteFailed }
    let written = data.withUnsafeBytes { buffer -> Bool in
        guard var pointer = buffer.baseAddress else { return false }
        var remaining = buffer.count
        while remaining > 0 {
            let count = write(descriptor, pointer, remaining)
            guard count > 0 else { return false }
            pointer = pointer.advanced(by: count)
            remaining -= count
        }
        return true
    }
    guard written, fsync(descriptor) == 0 else { throw InspectionFailure.outputWriteFailed }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          (information.st_mode & 0o077) == 0,
          information.st_nlink == 1,
          information.st_size == off_t(data.count)
    else { throw InspectionFailure.outputWriteFailed }
}

func closeEnough(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    let tolerance = 0.001
    return abs(lhs.origin.x - rhs.origin.x) <= tolerance && abs(lhs.origin.y - rhs.origin.y) <= tolerance
        && abs(lhs.width - rhs.width) <= tolerance && abs(lhs.height - rhs.height) <= tolerance
}


private func verifiesMutation(_ mutation: Mutation, document: PDFDocument) -> Bool {
    if let patch = mutation.metadata {
        let observed = metadata(document)
        guard observed.title == patch.title, observed.author == patch.author,
              observed.subject == patch.subject, observed.keywords == patch.keywords else { return false }
    }
    if let edit = mutation.pageBox {
        guard let page = document.page(at: edit.page - 1), let box = displayBox(edit.box),
              closeEnough(page.bounds(for: box), cgRect(edit.rect)) else { return false }
        if box == .mediaBox {
            let media = page.bounds(for: .mediaBox)
            for dependentBox in [PDFDisplayBox.cropBox, .bleedBox, .trimBox, .artBox] {
                let dependent = page.bounds(for: dependentBox)
                guard dependent.width > 0, dependent.height > 0, media.contains(dependent) else { return false }
            }
        }
    }
    if let edit = mutation.rotation {
        guard let page = document.page(at: edit.page - 1), page.rotation == edit.degrees else { return false }
    }
    for edit in mutation.annotations {
        guard let page = document.page(at: edit.page - 1), page.annotations.contains(where: {
            annotationSubtype($0) == edit.subtype && $0.contents == edit.contents
                && (edit.subtype == "text" || closeEnough($0.bounds, cgRect(edit.rect)))
        }) else { return false }
    }
    return true
}

func mutate(_ request: MutationRequest, workspace: URL, inputData: Data) throws -> StandardMutationReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard request.sourceSha256 == sourceDigest,
          let document = PDFDocument(data: inputData),
          mutationCanApply(request.mutation, document: document, limits: request.limits) else {
        throw InspectionFailure.mutationFailed
    }
    let rotationSnapshot = request.mutation.rotation.flatMap { _ in
        pageRotationSnapshot(request.mutation, document: document, limits: request.limits)
    }
    let pageBoxSafetySnapshot = ["crop", "bleed"].contains(request.mutation.pageBox?.box ?? "") ?
        pageBoxSnapshot(request.mutation, document: document, limits: request.limits) : nil
    guard request.mutation.rotation == nil || rotationSnapshot != nil else {
        throw InspectionFailure.mutationFailed
    }
    guard !["crop", "bleed"].contains(request.mutation.pageBox?.box ?? "") || pageBoxSafetySnapshot != nil else {
        throw InspectionFailure.mutationFailed
    }
    if let patch = request.mutation.metadata { setMetadata(patch, document: document) }
    if let pageBox = request.mutation.pageBox, !applyPageBox(pageBox, document: document) { throw InspectionFailure.mutationFailed }
    if let rotation = request.mutation.rotation, !applyPageRotation(rotation, document: document) {
        throw InspectionFailure.mutationFailed
    }
    for annotation in request.mutation.annotations where !applyAnnotation(annotation, document: document) {
        throw InspectionFailure.mutationFailed
    }
    guard let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes,
          let candidate = PDFDocument(data: outputData),
          verifiesMutation(request.mutation, document: candidate),
          (rotationSnapshot.map {
              verifiesPageRotation(request.mutation, document: candidate, snapshot: $0, limits: request.limits)
          } ?? true),
          (pageBoxSafetySnapshot.map {
              verifiesPageBox(request.mutation, document: candidate, snapshot: $0, limits: request.limits)
          } ?? true)
    else {
        throw InspectionFailure.mutationFailed
    }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData), reopened.pageCount == document.pageCount else {
        throw InspectionFailure.outputInvalid
    }
    guard verifiesMutation(request.mutation, document: reopened),
          (rotationSnapshot.map {
              verifiesPageRotation(request.mutation, document: reopened, snapshot: $0, limits: request.limits)
          } ?? true),
          (pageBoxSafetySnapshot.map {
              verifiesPageBox(request.mutation, document: reopened, snapshot: $0, limits: request.limits)
          } ?? true)
    else { throw InspectionFailure.outputInvalid }
    return StandardMutationReceipt(
        sourceSha256: sourceDigest,
        outputSha256: sha256Hex(reopenedData),
        appliedEdits: requestedEditCount(request.mutation),
        inspection: try inspect(reopened, limits: request.limits, sourceData: reopenedData)
    )
}
