import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics

private func inkAnnotationSnapshot(
    _ request: InkAnnotationRequest,
    document: PDFDocument
) -> InkAnnotationSnapshot? {
    let points = request.ink.points.map(inkAnnotationPoint)
    guard !document.isLocked, document.allowsCommenting, document.allowsDocumentChanges,
          document.pageCount >= 1, document.pageCount <= request.limits.maxPages,
          request.ink.page <= document.pageCount,
          let targetPage = document.page(at: request.ink.page - 1),
          targetPage.annotations.count < request.limits.maxAnnotationsPerPage,
          targetPage.annotations.count < maximumAnnotationsPerPage,
          points.allSatisfy({ cropBoxContains($0, crop: targetPage.bounds(for: .cropBox)) }),
          boundedGeometryRect(points, crop: targetPage.bounds(for: .cropBox)) != nil,
          lineAnnotationGraphIsSafe(document, limits: request.limits)
    else { return nil }

    var pageBoxes: [PageBoxes] = []
    var rotations: [Int] = []
    var annotationCounts: [Int] = []
    var annotationSubtypes: [[String]] = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= request.limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage
        else { return nil }
        pageBoxes.append(localGoToPageBoxes(page))
        rotations.append(page.rotation)
        annotationCounts.append(page.annotations.count)
        annotationSubtypes.append(page.annotations.map(annotationSubtype))
    }
    return InkAnnotationSnapshot(
        pageCount: document.pageCount,
        pageBoxes: pageBoxes,
        pageRotations: rotations,
        annotationCounts: annotationCounts,
        annotationSubtypes: annotationSubtypes
    )
}

private func applyInkAnnotation(_ ink: InkAnnotationEdit, document: PDFDocument) -> Bool {
    guard let page = document.page(at: ink.page - 1) else { return false }
    let points = ink.points.map(inkAnnotationPoint)
    guard let bounds = boundedGeometryRect(points, crop: page.bounds(for: .cropBox)),
          let first = points.first
    else { return false }
    let annotation = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
    let path = NSBezierPath()
    path.move(to: annotationSpacePoint(first, bounds: bounds))
    for point in points.dropFirst() { path.line(to: annotationSpacePoint(point, bounds: bounds)) }
    annotation.add(path)
    annotation.contents = ink.contents
    page.addAnnotation(annotation)
    return page.annotations.last === annotation
}

private func verifiesInkAnnotation(
    _ request: InkAnnotationRequest,
    document: PDFDocument,
    snapshot: InkAnnotationSnapshot
) -> Int? {
    guard document.pageCount == snapshot.pageCount,
          snapshot.pageBoxes.count == document.pageCount,
          snapshot.pageRotations.count == document.pageCount,
          snapshot.annotationCounts.count == document.pageCount,
          snapshot.annotationSubtypes.count == document.pageCount,
          lineAnnotationGraphIsSafe(document, limits: request.limits)
    else { return nil }

    let targetPageIndex = request.ink.page - 1
    let newAnnotationIndex = snapshot.annotationCounts[targetPageIndex]
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              localGoToPageBoxes(page) == snapshot.pageBoxes[pageIndex],
              page.rotation == snapshot.pageRotations[pageIndex]
        else { return nil }
        let addedHere = pageIndex == targetPageIndex ? 1 : 0
        guard page.annotations.count == snapshot.annotationCounts[pageIndex] + addedHere,
              page.annotations.map(annotationSubtype)
                == snapshot.annotationSubtypes[pageIndex] + (addedHere == 1 ? ["ink"] : [])
        else { return nil }
    }

    guard let page = document.page(at: targetPageIndex),
          newAnnotationIndex < page.annotations.count
    else { return nil }
    let annotation = page.annotations[newAnnotationIndex]
    let points = request.ink.points.map(inkAnnotationPoint)
    guard let paths = annotation.paths, paths.count == 1, let path = paths.first,
          annotationSubtype(annotation) == "ink",
          annotation.contents == request.ink.contents,
          !annotation.bounds.isNull, !annotation.bounds.isInfinite,
          annotation.bounds.width > 0, annotation.bounds.height > 0,
          page.bounds(for: .cropBox).contains(annotation.bounds),
          annotationIsInertTarget(annotation),
          pathMatches(path, points: points, closed: false, origin: annotation.bounds.origin),
          rawInkAnnotationMatches(document, page: request.ink.page, annotationIndex: newAnnotationIndex, points: points)
    else { return nil }
    return newAnnotationIndex
}

func addInkAnnotation(
    _ request: InkAnnotationRequest,
    workspace: URL,
    inputData: Data
) throws -> InkAnnotationReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard sourceDigest == request.sourceSha256,
          let document = PDFDocument(data: inputData),
          let snapshot = inkAnnotationSnapshot(request, document: document),
          applyInkAnnotation(request.ink, document: document),
          let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes,
          sha256Hex(outputData) != sourceDigest,
          let candidate = PDFDocument(data: outputData),
          verifiesInkAnnotation(request, document: candidate, snapshot: snapshot) != nil
    else { throw InspectionFailure.mutationFailed }

    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData),
          let annotationIndex = verifiesInkAnnotation(request, document: reopened, snapshot: snapshot)
    else { throw InspectionFailure.outputInvalid }
    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return InkAnnotationReceipt(
        sourceSha256: sourceDigest,
        outputSha256: outputDigest,
        page: request.ink.page,
        annotationIndex: annotationIndex,
        pageCount: reopened.pageCount
    )
}
