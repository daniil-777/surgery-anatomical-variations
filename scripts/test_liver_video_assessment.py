"""Run: python -m unittest discover -s scripts -p test_liver_video_assessment.py"""
import unittest
import cv2
import numpy as np
from assess_liver_videos import pair_metrics
from assess_liver_trajectories import shape_change, tetra_determinants

class VideoAssessmentTests(unittest.TestCase):
    def setUp(self):
        rng=np.random.default_rng(1701)
        self.image=rng.integers(20,235,(100,120,3),dtype=np.uint8)
    def test_identity_and_known_pixel_translation(self):
        same=pair_metrics(self.image,self.image,.5,False)
        self.assertLess(same['flow_median_px_s'],.05)
        shifted=cv2.warpAffine(self.image,np.float32([[1,0,3],[0,1,0]]),(120,100),borderMode=cv2.BORDER_REFLECT)
        shifted=pair_metrics(self.image,shifted,.5,False)
        self.assertAlmostEqual(shifted['flow_median_px_s'],6,delta=.15)
    def test_unobservable_roi_and_invalid_time(self):
        blank=np.zeros((100,120,3),dtype=np.uint8)
        self.assertIsNone(pair_metrics(blank,blank,.5,False)['flow_median_px_s'])
        for dt in [0,-1,float('nan')]:
            with self.assertRaises(ValueError):pair_metrics(blank,blank,dt,False)
        with self.assertRaises(ValueError):pair_metrics(blank,blank[:50],.5,False)
    def test_rigid_motion_is_not_shape_change(self):
        a=np.array([[0,0,0],[1,0,0],[0,1,0],[0,0,1.]])
        rotation=np.array([[0,-1,0],[1,0,0],[0,0,1.]])
        r=shape_change(a,a@rotation+[100,30,-20])
        self.assertLess(r['rigid_aligned_rms_mm'],1e-12)
        self.assertLess(r['all_pair_distance_change_rms_mm'],1e-12)
        self.assertGreater(r['centroid_displacement_mm'],100)
        self.assertGreater(shape_change(a,2*a)['rigid_aligned_rms_mm'],.1)
    def test_tetra_volume_and_inversion(self):
        a=np.array([[0,0,0],[1,0,0],[0,1,0],[0,0,1.]])
        self.assertEqual(tetra_determinants(a,np.array([[0,1,2,3]]))[0],1)
        self.assertEqual(tetra_determinants(a,np.array([[0,2,1,3]]))[0],-1)

if __name__=='__main__':unittest.main()
